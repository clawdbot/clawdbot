import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isTransientNetworkError } from "../../infra/retryable-network-errors.js";
import {
  extractLeadingHttpStatus,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import {
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
} from "./message-patterns.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";
const FAILOVER_TIMEOUT_ERROR_CODES = new Set([
  "EHOSTDOWN",
  "ENETRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const NO_BODY_HTTP_WRAPPER_RE =
  /^(?:no body(?: response)?|no response body|status code \(no body\))$/i;
function stripErrorPrefix(raw: string): string {
  return raw.replace(/^error:\s*/i, "").trim();
}
export function inferSignalStatus(signal: FailoverSignal): number | undefined {
  if (typeof signal.status === "number" && Number.isFinite(signal.status)) {
    return signal.status;
  }
  return extractLeadingHttpStatus(stripErrorPrefix(signal.message?.trim() ?? ""))?.code;
}
function isExplicitNoBodyHttpMessage(raw: string | undefined, status?: number): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = extractLeadingHttpStatus(trimmed) ? trimmed : stripErrorPrefix(trimmed);
  const leadingStatus = extractLeadingHttpStatus(candidate);
  if (leadingStatus) {
    if (typeof status === "number" && leadingStatus.code !== status) {
      return false;
    }
    return NO_BODY_HTTP_WRAPPER_RE.test(leadingStatus.rest);
  }
  return NO_BODY_HTTP_WRAPPER_RE.test(candidate);
}
export function isUnclassifiedNoBodyHttpSignal(signal: FailoverSignal): boolean {
  const status = inferSignalStatus(signal);
  if (status !== 400 && status !== 422) {
    return false;
  }
  const message = signal.message?.trim();
  return !message || isExplicitNoBodyHttpMessage(message, status);
}
type PaymentRequiredFailoverReason = Extract<FailoverReason, "billing" | "rate_limit">;
// Provider SDKs often keep semantic error fields outside Error.message.
// These bounded candidates feed classification only; user-facing copy still
// comes from the normal sanitized formatter path.
const BILLING_402_HINTS = [
  "insufficient credits",
  "insufficient quota",
  "credit balance",
  "insufficient balance",
  "plans & billing",
  "add more credits",
  "top up",
] as const;
const BILLING_402_PLAN_HINTS = [
  "upgrade your plan",
  "upgrade plan",
  "current plan",
  "subscription",
] as const;
const PERIODIC_402_HINTS = ["daily", "weekly", "monthly"] as const;
const RETRYABLE_402_RETRY_HINTS = ["try again", "retry", "temporary", "cooldown"] as const;
const RETRYABLE_402_LIMIT_HINTS = ["usage limit", "rate limit", "organization usage"] as const;
const RETRYABLE_402_SCOPED_HINTS = ["organization", "workspace"] as const;
const RETRYABLE_402_SCOPED_RESULT_HINTS = [
  "billing period",
  "exceeded",
  "reached",
  "exhausted",
] as const;
const RAW_402_MARKER_RE =
  /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+(?:payment required\b|.*used up your points\b|no available asset for api access\b)/i;
const BARE_LEADING_402_RE = /^\s*402\b/i;
const LEADING_402_WRAPPER_RE =
  /^(?:error[:\s-]+)?(?:(?:http\s*)?402(?:\s+payment required)?|payment required)(?:[:\s-]+|$)/i;
function includesAnyHint(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}
function hasExplicit402BillingSignal(text: string): boolean {
  return (
    includesAnyHint(text, BILLING_402_HINTS) ||
    (includesAnyHint(text, BILLING_402_PLAN_HINTS) && text.includes("limit")) ||
    text.includes("billing hard limit") ||
    text.includes("hard limit reached") ||
    (text.includes("maximum allowed") && text.includes("limit"))
  );
}
function hasQuotaRefreshWindowSignal(text: string): boolean {
  return (
    text.includes("subscription quota limit") &&
    (text.includes("automatic quota refresh") || text.includes("rolling time window"))
  );
}
function hasRetryable402TransientSignal(text: string): boolean {
  const hasPeriodicHint = includesAnyHint(text, PERIODIC_402_HINTS);
  const hasSpendLimit = text.includes("spend limit") || text.includes("spending limit");
  const hasScopedHint = includesAnyHint(text, RETRYABLE_402_SCOPED_HINTS);
  return (
    (includesAnyHint(text, RETRYABLE_402_RETRY_HINTS) &&
      includesAnyHint(text, RETRYABLE_402_LIMIT_HINTS)) ||
    (hasPeriodicHint && (text.includes("usage limit") || hasSpendLimit)) ||
    (hasPeriodicHint && text.includes("limit") && text.includes("reset")) ||
    (hasScopedHint &&
      text.includes("limit") &&
      (hasSpendLimit || includesAnyHint(text, RETRYABLE_402_SCOPED_RESULT_HINTS)))
  );
}
function hasKnownBareLeading402Signal(text: string): boolean {
  return (
    hasQuotaRefreshWindowSignal(text) ||
    hasExplicit402BillingSignal(text) ||
    isRateLimitErrorMessage(text) ||
    hasRetryable402TransientSignal(text)
  );
}
function normalize402Message(raw: string): string {
  return normalizeOptionalLowercaseString(raw)?.replace(LEADING_402_WRAPPER_RE, "").trim() ?? "";
}
function classify402Message(message: string): PaymentRequiredFailoverReason {
  const normalized = normalize402Message(message);
  if (!normalized) {
    return "billing";
  }
  if (hasQuotaRefreshWindowSignal(normalized)) {
    return "rate_limit";
  }
  if (hasExplicit402BillingSignal(normalized)) {
    return "billing";
  }
  if (isRateLimitErrorMessage(normalized)) {
    return "rate_limit";
  }
  if (hasRetryable402TransientSignal(normalized)) {
    return "rate_limit";
  }
  return "billing";
}
export function classifyFailoverReasonFrom402Text(
  raw: string,
): PaymentRequiredFailoverReason | null {
  if (RAW_402_MARKER_RE.test(raw)) {
    return classify402Message(raw);
  }
  if (!BARE_LEADING_402_RE.test(raw)) {
    return null;
  }
  const normalized = normalize402Message(raw);
  if (!normalized || !hasKnownBareLeading402Signal(normalized)) {
    return null;
  }
  return classify402Message(raw);
}
export function toReasonClassification(reason: FailoverReason): FailoverClassification {
  return { kind: "reason", reason };
}
export function toPluginClassification(reason: FailoverReason): FailoverClassification {
  return reason === "context_overflow"
    ? { kind: "context_overflow" }
    : toReasonClassification(reason);
}
export function failoverReasonFromClassification(
  classification: FailoverClassification | null,
): FailoverReason | null {
  if (!classification) {
    return null;
  }
  return classification.kind === "reason" ? classification.reason : "context_overflow";
}
export function classifyFailoverClassificationFromHttpStatus(
  status: number | undefined,
  message: string | undefined,
  messageClassification: FailoverClassification | null,
  explicitStatus: number | undefined,
  provider?: string,
  opts?: { preserveProviderSignalClassification?: boolean },
): FailoverClassification | null {
  const messageReason = failoverReasonFromClassification(messageClassification);
  if (typeof status !== "number" || !Number.isFinite(status)) {
    return null;
  }
  if (status === 402) {
    if (!message) {
      return toReasonClassification("billing");
    }
    const leadingStatus = extractLeadingHttpStatus(message.trim());
    if (leadingStatus?.code === 402) {
      const reasonFrom402Text = classifyFailoverReasonFrom402Text(message);
      if (reasonFrom402Text) {
        return toReasonClassification(reasonFrom402Text);
      }
      return typeof explicitStatus === "number"
        ? toReasonClassification(classify402Message(message))
        : messageClassification;
    }
    return toReasonClassification(classify402Message(message));
  }
  if (status === 429) {
    if (messageReason === "billing" && !isAmbiguousGeneric429BalanceMessage(message ?? "")) {
      return toReasonClassification("billing");
    }
    if (message && isBilling429MessageForProvider(message, provider)) {
      return toReasonClassification("billing");
    }
    return toReasonClassification("rate_limit");
  }
  if (status === 401 || status === 403) {
    if (opts?.preserveProviderSignalClassification && messageClassification) {
      return messageClassification;
    }
    if (message && isAuthPermanentErrorMessage(message)) {
      return toReasonClassification("auth_permanent");
    }
    // Provider-owned billing classifications on ambiguous 401/403 responses
    // take precedence over generic auth.
    if (messageReason === "billing") {
      return toReasonClassification("billing");
    }
    return toReasonClassification("auth");
  }
  if (status === 408) {
    return toReasonClassification("timeout");
  }
  if (status === 410) {
    // Generic 410/no-body responses behave like transport failures, not session expiry.
    if (
      messageReason === "session_expired" ||
      messageReason === "billing" ||
      messageReason === "auth_permanent" ||
      messageReason === "auth"
    ) {
      return messageClassification;
    }
    return toReasonClassification("timeout");
  }
  // Context payloads can use 5xx; preserve the compaction decision before generic status mapping.
  if (messageClassification?.kind === "context_overflow") {
    return messageClassification;
  }
  if (status === 404) {
    if (
      messageReason === "session_expired" ||
      messageReason === "billing" ||
      messageReason === "auth_permanent" ||
      messageReason === "auth" ||
      messageReason === "format"
    ) {
      return messageClassification;
    }
    return toReasonClassification("model_not_found");
  }
  if (status === 529) {
    return toReasonClassification("overloaded");
  }
  if (status === 499 || (status >= 500 && status < 600)) {
    return messageReason === "overloaded" || messageReason === "server_error"
      ? messageClassification
      : toReasonClassification("timeout");
  }
  if (status === 400 || status === 422) {
    // 400/422 are ambiguous: inspect the payload first so provider-specific
    // rate limits, auth failures, model-not-found errors, and billing signals
    // are not collapsed into generic "format" failures.
    if (messageClassification && messageReason !== "server_error") {
      return messageClassification;
    }
    // When the response has no body at all, or only surfaces as an HTTP wrapper
    // like "400 status code (no body)", return null instead of defaulting to
    // "format". These shapes are likely transient proxy issues — classifying
    // them as "format" triggers a compaction loop that cannot recover.
    if (isUnclassifiedNoBodyHttpSignal({ status, message })) {
      return null;
    }
    // Body exists but couldn't be classified — still treat as format error
    // since the provider rejected the request schema.
    return toReasonClassification("format");
  }
  return null;
}
// Only cross-provider structured codes classify in core; provider-native
// mappings belong to provider hooks.
export function classifyFailoverReasonFromCode(raw: string | undefined): FailoverReason | null {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case "RESOURCE_EXHAUSTED":
    case "RATE_LIMIT":
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
    case "TOO_MANY_REQUESTS":
    case "THROTTLED":
    case "THROTTLING":
    case "THROTTLINGEXCEPTION":
    case "THROTTLING_EXCEPTION":
      return "rate_limit";
    case "DEACTIVATED_WORKSPACE":
      return "auth_permanent";
    case "OVERLOADED":
    case "OVERLOADED_ERROR":
      return "overloaded";
    default:
      return FAILOVER_TIMEOUT_ERROR_CODES.has(normalized) ||
        isTransientNetworkError({ code: normalized })
        ? "timeout"
        : null;
  }
}
export function classifyCoreFailoverReasonFromErrorType(
  raw: string | undefined,
): FailoverReason | null {
  const normalized = normalizeOptionalLowercaseString(raw);
  switch (normalized) {
    case "invalid_request_error":
      return "format";
    case "server_error":
    case "upstream_error":
      return "server_error";
    case "overloaded_error":
      return "overloaded";
    default:
      return null;
  }
}
export function classifyFailoverClassificationFromErrorType(
  raw: string | undefined,
): FailoverClassification | null {
  const reason = classifyCoreFailoverReasonFromErrorType(raw);
  return reason ? toReasonClassification(reason) : null;
}
function isProvider(provider: string | undefined, match: string): boolean {
  const normalized = normalizeOptionalLowercaseString(provider);
  return Boolean(normalized && normalized.includes(match));
}
function hasProviderBilling429Override(provider: string | undefined): boolean {
  return (
    isProvider(provider, "xai") || isProvider(provider, "moonshot") || isProvider(provider, "kimi")
  );
}
function hasStructuredBilling429Signal(raw: string): boolean {
  if (hasBillingApiErrorType(raw)) {
    return true;
  }
  const leadingStatus = extractLeadingHttpStatus(raw.trim());
  return Boolean(leadingStatus?.rest && hasBillingApiErrorType(leadingStatus.rest));
}
function hasBillingApiErrorType(raw: string): boolean {
  const type = normalizeOptionalLowercaseString(parseApiErrorInfo(raw)?.type);
  if (!type) {
    return false;
  }
  return isBillingErrorMessage(type) || isBillingErrorMessage(type.replaceAll("_", " "));
}
function isAmbiguousGeneric429BalanceMessage(raw: string): boolean {
  return /\binsufficient\s+account\s+balance\b/i.test(raw) && !hasStructuredBilling429Signal(raw);
}
function isBilling429MessageForProvider(raw: string, provider: string | undefined): boolean {
  if (!isBillingErrorMessage(raw)) {
    return false;
  }
  return hasProviderBilling429Override(provider) || !isAmbiguousGeneric429BalanceMessage(raw);
}
// shared model runtime providers throw `Error("An unknown error occurred")` provider-agnostically
// (anthropic, google, vertex, openai-completions, mistral, bedrock, etc.) when a
// stream ends with stopReason === "aborted" | "error" without specific info. Treat
// it as a transient transport failure so the configured fallback chain rotates
// instead of returning the bare string to the user (#71620).
export function isGenericUnknownStreamErrorMessage(raw: string): boolean {
  return /^\s*an unknown error occurred\.?\s*$/i.test(raw);
}
export function isExactUnknownNoDetailsError(raw: string): boolean {
  return (
    normalizeOptionalLowercaseString(raw)?.trim() === "unknown error (no error details in response)"
  );
}
export function isClaudeCliAuthError(raw: string, provider?: string): boolean {
  // These upstream phrases overlap generic session/auth wording. Provider identity
  // must come from runner metadata so other CLIs cannot inherit Claude policy.
  if (normalizeOptionalLowercaseString(provider)?.trim() !== "claude-cli") {
    return false;
  }
  return /\bnot logged in\b\s*·\s*please run \/login\b|\bfailed to authenticate:\s*oauth session expired and could not be refreshed\b/i.test(
    raw,
  );
}
export function isUnsupportedImageInputErrorMessage(raw: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return false;
  }
  return (
    /\bdoes not support image inputs?\b/.test(normalized) ||
    /\bunsupported image input\b/.test(normalized) ||
    (/\bno endpoints found\b/.test(normalized) && /\bsupport image input\b/.test(normalized))
  );
}
