/**
 * Normalizes and classifies compaction failure reasons for diagnostics.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { extractFailoverHttpStatus } from "../failover/retry-evidence.js";

const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;
const COMPACTION_PROVIDER_4XX = new Set([400, 401, 403, 429]);
const COMPACTION_PROVIDER_5XX = new Set([500, 502, 503, 504]);

export const DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON =
  "deferred to background context-engine maintenance";

function isGenericCompactionCancelledReason(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}

/** Prefer a safeguard cancel reason when the runtime only reports generic cancellation. */
export function resolveCompactionFailureReason(params: {
  reason: string;
  safeguardCancelReason?: string | null;
}): string {
  if (isGenericCompactionCancelledReason(params.reason) && params.safeguardCancelReason) {
    return params.safeguardCancelReason;
  }
  return params.reason;
}

/** Bucket a raw compaction reason into stable telemetry/status classes. */
export function classifyCompactionReason(reason?: string): string {
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
  if (text.includes("nothing to compact") || text.includes("no real conversation messages")) {
    return "no_compactable_entries";
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
  return (
    isBenignCompactionSkipReason(result.reason) ||
    (result.ok && classifyCompactionReason(result.reason) === "no_compactable_entries")
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
