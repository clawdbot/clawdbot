/**
 * Normalizes and classifies compaction failure reasons for diagnostics.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { CompactionSafeguardCancellation } from "../agent-hooks/compaction-safeguard-runtime.js";
import { extractFailoverHttpStatus } from "../failover/retry-evidence.js";

const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;
const COMPACTION_PROVIDER_4XX = new Set([400, 401, 403, 429]);
const COMPACTION_PROVIDER_5XX = new Set([500, 502, 503, 504]);

export const DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON =
  "deferred to background context-engine maintenance";

/**
 * Closed union of compaction-attempt outcomes returned by
 * {@link classifyCompactionReason}. Replaces the prior bare `string` return,
 * which forced consumers to substring-match on free-form messages.
 *
 * Add new variants here when the classifier learns a new shape.
 */
export type CompactionReasonCode =
  | "unknown"
  | "no_compactable_entries"
  | "no_real_conversation_messages"
  | "unknown_model"
  | "below_threshold"
  | "already_compacted"
  | "deferred_background"
  | "live_context_still_exceeds_target"
  | "transcript_persistence_failed"
  | "guard_blocked"
  | "summary_failed"
  | "timeout"
  | "auth_failed"
  | "provider_error_4xx"
  | "provider_error_5xx";

/**
 * Reason codes that mean "compaction did not run, but for a legitimate
 * non-error cause" — caller should treat the request as gracefully skipped
 * rather than as a failure.
 *
 * Single source of truth shared by the request-compaction tool and the
 * /compact command.
 */
const SKIP_CODES: ReadonlySet<CompactionReasonCode> = new Set([
  "no_compactable_entries",
  "no_real_conversation_messages",
  "below_threshold",
  "already_compacted",
  "deferred_background",
]);

export function isCompactionSkipCode(code: CompactionReasonCode): boolean {
  return SKIP_CODES.has(code);
}

/**
 * Convenience wrapper: classify a free-form reason string, then check whether
 * the resulting code is a skip-class outcome. Replaces the duplicated
 * `isLegitSkipReason` / `isCompactionSkipReason` substring helpers.
 */
export function isCompactionSkipReason(reason?: string): boolean {
  return isCompactionSkipCode(classifyCompactionReason(reason));
}

function isGenericCompactionCancelledReason(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}

/** Project display text and failure provenance together, without classifying intentional declines. */
export function resolveCompactionFailure(params: {
  error: unknown;
  safeguardCancellation?: CompactionSafeguardCancellation | null;
  abortSignal?: AbortSignal;
}): { reason: string; error: unknown } {
  const reason = formatErrorMessage(params.error);
  // AgentSessionCompaction wraps hook cancellation in a plain Error("Compaction cancelled").
  // Only that wrapper yields to safeguard provenance; genuine errors and caller aborts win.
  const cancellation =
    !params.abortSignal?.aborted &&
    params.error instanceof Error &&
    params.error.name === "Error" &&
    isGenericCompactionCancelledReason(reason)
      ? params.safeguardCancellation
      : undefined;
  return { reason: cancellation?.reason ?? reason, error: cancellation?.error ?? params.error };
}

/** Bucket a raw compaction reason into stable telemetry/status classes. */
export function classifyCompactionReason(reason?: string): CompactionReasonCode {
  const text = normalizeLowercaseStringOrEmpty(reason);
  if (!text) {
    return "unknown";
  }
  if (
    text.startsWith("no api key found") ||
    (text.startsWith("authentication failed for ") && text.includes("credentials may have expired"))
  ) {
    return "auth_failed";
  }
  if (text.includes("nothing to compact")) {
    return "no_compactable_entries";
  }
  if (text.includes("no real conversation messages")) {
    return "no_real_conversation_messages";
  }
  if (text.includes("unknown model")) {
    // Surfaced when DEFAULT_PROVIDER/DEFAULT_MODEL fallback hits an unsupported
    // model, e.g. volitional compaction without provider/model passed.
    return "unknown_model";
  }
  // Backends use both phrases for the same harmless state: the transcript is
  // already small enough, so preflight compaction should skip instead of fail.
  if (text.includes("below threshold") || text.includes("already under target")) {
    return "below_threshold";
  }
  if (text.includes("already compacted") || text.includes("already_compacted")) {
    return "already_compacted";
  }
  if (text.includes("deferred to background")) {
    return "deferred_background";
  }
  if (text.includes("still exceeds target")) {
    return "live_context_still_exceeds_target";
  }
  if (text.includes("session transcript") && text.includes("not persisted")) {
    return "transcript_persistence_failed";
  }
  if (text.includes("guard")) {
    return "guard_blocked";
  }
  if (text.includes("summary")) {
    return "summary_failed";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  const status = extractFailoverHttpStatus(reason, { includeLabeledStatus: true });
  if (status !== undefined && COMPACTION_PROVIDER_4XX.has(status)) {
    return "provider_error_4xx";
  }
  if (status !== undefined && COMPACTION_PROVIDER_5XX.has(status)) {
    return "provider_error_5xx";
  }
  return "unknown";
}

/** Return whether a classified reason represents an intentional compaction no-op. */
export function isBenignCompactionSkipReason(reason?: string): boolean {
  const classification = classifyCompactionReason(reason);
  return classification === "below_threshold" || classification === "already_compacted";
}

/** Return whether a compaction result is an intentional no-op rather than a failure. */
export function isBenignCompactionSkipResult(result: {
  ok: boolean;
  compacted: boolean;
  reason?: string;
}): boolean {
  if (result.compacted) {
    return false;
  }
  const classification = classifyCompactionReason(result.reason);
  return (
    isBenignCompactionSkipReason(result.reason) ||
    (result.ok &&
      (classification === "no_compactable_entries" ||
        classification === "no_real_conversation_messages"))
  );
}

/** Sanitize an unknown reason into a short log/metric-safe detail suffix. */
export function formatUnknownCompactionReasonDetail(reason?: string): string | undefined {
  const sanitized = sanitizeForLog((reason ?? "").replace(/\s+/g, " "))
    .trim()
    .replace(/[^A-Za-z0-9._:@/+~-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, MAX_COMPACTION_REASON_DETAIL_CHARS);
}
