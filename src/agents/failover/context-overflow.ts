import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isBillingErrorMessage, isRateLimitErrorMessage } from "./message-patterns.js";
import {
  classifyProviderPluginError,
  looksLikeProviderContextOverflowCandidate,
} from "./provider-patterns.js";

export function isReasoningConstraintErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("reasoning is mandatory") ||
    lower.includes("reasoning is required") ||
    lower.includes("requires reasoning") ||
    (lower.includes("reasoning") && lower.includes("cannot be disabled"))
  );
}

function hasRateLimitTpmHint(raw: string): boolean {
  return matchesContextOverflowMessage(raw, "tpm-rate-limit-hint");
}

// Both figures must be denominated in tokens and come from one clause. A message can state an RPM
// limit and mention TPM elsewhere, and reading the pair on its own would compare a request count
// against a token budget; requiring the unit to lead the clause keeps the numbers commensurable.
const STATED_TOKEN_SIZES_RE =
  /(?:\btpm\b|tokens per minute)[^.\n]*?\blimit\s+([\d,]+)[^.\n]*?\brequested\s+([\d,]+)/i;

function readStatedTokenCount(digits: string | undefined): number | undefined {
  const parsed = Number(digits?.replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Groq denominates a per-request size ceiling per minute: an oversized single request is refused
 * with a 413 naming TPM that states both `Limit <n>` and `Requested <m>`. A request larger than
 * the whole limit does not fit even an empty bucket, so waiting can never admit it. Ordinary
 * throttling states a requested size within the limit and remains a rate limit.
 *
 * The ceiling belongs to the request and to the refusing provider's quota, not to the model's
 * context window, so compaction budgeted against that window cannot satisfy it either. Overflow
 * Embedded recovery surfaces reset guidance without retrying. If a transport-owning harness
 * bypasses that recovery, model failover may advance to a differently provisioned candidate.
 */
export function isProviderRequestSizeCeilingError(errorMessage?: string): boolean {
  if (!errorMessage || !hasRateLimitTpmHint(errorMessage)) {
    return false;
  }
  const stated = STATED_TOKEN_SIZES_RE.exec(errorMessage);
  const limit = readStatedTokenCount(stated?.[1]);
  const requested = readStatedTokenCount(stated?.[2]);
  return limit !== undefined && requested !== undefined && requested > limit;
}

/** Detect explicit context-window overflow without confusing TPM rate limits. */
export function isContextOverflowErrorFromTables(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context
  // overflow — unless the request alone exceeds the whole limit, which no wait can satisfy.
  if (hasRateLimitTpmHint(errorMessage) && !isProviderRequestSizeCeilingError(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  return (
    matchesContextOverflowMessage(errorMessage, "failover-explicit") ||
    (looksLikeProviderContextOverflowCandidate(errorMessage) &&
      matchesContextOverflowMessage(errorMessage, "provider-fallback"))
  );
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  return (
    isContextOverflowErrorFromTables(errorMessage) ||
    (looksLikeProviderContextOverflowCandidate(errorMessage) &&
      classifyProviderPluginError({ errorMessage }) === "context_overflow")
  );
}

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Settle an unsatisfiable request size first: the TPM and rate-limit exclusions below would
  // otherwise claim the message on its rate-limit wording alone.
  if (isProviderRequestSizeCeilingError(errorMessage)) {
    return isContextOverflowErrorFromTables(errorMessage);
  }

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  // Billing/quota errors can contain patterns like "request size exceeds" or
  // "maximum token limit exceeded" that match the context overflow heuristic.
  // Billing is a more specific error class - exclude it early.
  if (isBillingErrorMessage(errorMessage)) {
    return false;
  }

  if (matchesContextOverflowMessage(errorMessage, "context-window-too-small")) {
    return false;
  }
  // Rate limit errors can match the broad CONTEXT_OVERFLOW_HINT_RE pattern
  // (e.g., "request reached organization TPD rate limit" matches request.*limit).
  // Exclude them before checking context overflow heuristics.
  if (isRateLimitErrorMessage(errorMessage)) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return true;
  }
  if (normalizeLowercaseStringOrEmpty(errorMessage).includes("prompt template")) {
    return false;
  }
  if (matchesContextOverflowMessage(errorMessage, "rate-limit-hint")) {
    return false;
  }
  return matchesContextOverflowMessage(errorMessage, "failover-hint");
}
