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

/** Detect explicit context-window overflow without confusing TPM rate limits. */
export function isContextOverflowErrorFromTables(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
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
