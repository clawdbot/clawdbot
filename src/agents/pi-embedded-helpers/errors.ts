import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
export {
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { classifyOAuthRefreshFailure } from "../auth-profiles/oauth-refresh-failure.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import { isModelNotFoundErrorMessage } from "../live-model-errors.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox/runtime-status.js";
import {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
  matchesFormatErrorPattern,
} from "./failover-matches.js";
import {
  classifyProviderSpecificError,
  matchesProviderContextOverflow,
} from "./provider-error-patterns.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatDiskSpaceErrorCopy,
  formatRateLimitOrOverloadedErrorCopy,
  formatTransportErrorCopy,
  getApiErrorPayloadFingerprint,
  isInvalidStreamingEventOrderError,
  isLikelyHttpErrorText,
  isRawApiErrorPayload,
  sanitizeUserFacingText,
} from "./sanitize-user-facing-text.js";
import type { FailoverReason } from "./types.js";

export {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatRateLimitOrOverloadedErrorCopy,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  sanitizeUserFacingText,
} from "./sanitize-user-facing-text.js";

export {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

const log = createSubsystemLogger("errors");

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
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(errorMessage);

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  return (
    lower.includes("request_too_large") ||
    (lower.includes("invalid_argument") && lower.includes("maximum number of tokens")) ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (lower.includes("input exceeds") && lower.includes("maximum number of tokens")) ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
    // Anthropic API and OpenAI-compatible providers (e.g. ZhipuAI/GLM) return this stop reason
    // when the context window is exceeded. pi-ai surfaces it as "Unhandled stop reason: model_context_window_exceeded".
    lower.includes("context_window_exceeded") ||
    // Chinese proxy error messages for context overflow
    errorMessage.includes("上下文过长") ||
    errorMessage.includes("上下文超出") ||
    errorMessage.includes("上下文长度超") ||
    errorMessage.includes("超出最大上下文") ||
    errorMessage.includes("请压缩上下文") ||
    // Provider-specific patterns (Bedrock, Azure, Ollama, Mistral, Cohere, etc.)
    matchesProviderContextOverflow(errorMessage)
  );
}

const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE =
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i;

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
  // Billing is a more specific error class — exclude it early.
  if (isBillingErrorMessage(errorMessage)) {
    return false;
  }

  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) {
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
  if (RATE_LIMIT_HINT_RE.test(errorMessage)) {
    return false;
  }
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}

export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(errorMessage);
  const hasCompactionTerm =
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction");
  if (!hasCompactionTerm) {
    return false;
  }
  // Treat any likely overflow shape as a compaction failure when compaction terms are present.
  // Providers often vary wording (e.g. "context window exceeded") across APIs.
  if (isLikelyContextOverflowError(errorMessage)) {
    return true;
  }
  // Keep explicit fallback for bare "context overflow" strings.
  return lower.includes("context overflow");
}

const OBSERVED_OVERFLOW_TOKEN_PATTERNS = [
  /prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i,
  /requested\s+([\d,]+)\s+tokens/i,
  /resulted in\s+([\d,]+)\s+tokens/i,
];

export function extractObservedOverflowTokenCount(errorMessage?: string): number | undefined {
  if (!errorMessage) {
    return undefined;
  }

  for (const pattern of OBSERVED_OVERFLOW_TOKEN_PATTERNS) {
    const match = errorMessage.match(pattern);
    const rawCount = match?.[1]?.replaceAll(",", "");
    if (!rawCount) {
      continue;
    }
    const parsed = Number(rawCount);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

const TRANSIENT_HTTP_ERROR_CODES = new Set([499, 500, 502, 503, 504, 521, 522, 523, 524, 529]);

type PaymentRequiredFailoverReason = Extract<FailoverReason, "billing" | "rate_limit">;

export type FailoverSignal = {
  status?: number;
  code?: string;
  message?: string;
  provider?: string;
};

export type FailoverClassification =
  | {
      kind: "reason";
      reason: FailoverReason;
    }
  | {
      kind: "context_overflow";
    };

export type ProviderRuntimeFailureKind =
  | "auth_scope"
  | "auth_refresh"
  | "refresh_timeout"
  | "refresh_contention"
  | "callback_timeout"
  | "callback_validation"
  | "auth_html_403"
  | "upstream_html"
  | "proxy"
  | "rate_limit"
  | "dns"
  | "timeout"
  | "schema"
  | "sandbox_blocked"
  | "replay_invalid"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";

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
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETRESET",
  "EPIPE",
  "EAI_AGAIN",
]);
const AUTH_SCOPE_HINT_RE =
  /\b(?:missing|required|requires|insufficient)\s+(?:the\s+following\s+)?scopes?\b|\bmissing\s+scope\b/i;
const AUTH_SCOPE_NAME_RE = /\b(?:api\.responses\.write|model\.request)\b/i;
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
const PROXY_ERROR_RE =
  /\bproxyconnect\b|\bhttps?_proxy\b|\b407\b|\bproxy authentication required\b|\btunnel connection failed\b|\bconnect tunnel\b|\bsocks proxy\b|\bproxy error\b/i;
const DNS_ERROR_RE = /\benotfound\b|\beai_again\b|\bgetaddrinfo\b|\bno such host\b|\bdns\b/i;
const INTERRUPTED_NETWORK_ERROR_RE =
  /\beconnrefused\b|\beconnreset\b|\beconnaborted\b|\benetreset\b|\behostunreach\b|\behostdown\b|\benetunreach\b|\bepipe\b|\bsocket hang up\b|\bconnection refused\b|\bconnection reset\b|\bconnection aborted\b|\bnetwork is unreachable\b|\bhost is unreachable\b|\bfetch failed\b|\bconnection error\b|\bnetwork request failed\b/i;
const REPLAY_INVALID_RE =
  /\bprevious_response_id\b.*\b(?:invalid|unknown|not found|does not exist|expired|mismatch)\b|\btool_(?:use|call)\.(?:input|arguments)\b.*\b(?:missing|required)\b|\bincorrect role information\b|\broles must alternate\b|\binput item id does not belong to this connection\b/i;
const SANDBOX_BLOCKED_RE =
  /\bapproval is required\b|\bapproval timed out\b|\bapproval was denied\b|\bblocked by sandbox\b|\bsandbox\b.*\b(?:blocked|denied|forbidden|disabled|not allowed)\b/i;
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

function isHtmlErrorResponse(raw: string, status?: number): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = extractLeadingHttpStatus(trimmed) ? trimmed : stripErrorPrefix(trimmed);
  const inferred =
    typeof status === "number" && Number.isFinite(status)
      ? status
      : extractLeadingHttpStatus(candidate)?.code;
  if (typeof inferred !== "number" || inferred < 400) {
    return false;
  }
  const rest = extractLeadingHttpStatus(candidate)?.rest ?? candidate;
  return HTML_BODY_RE.test(rest) && HTML_CLOSE_RE.test(rest);
}

function isTransportHtmlErrorStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 499 ||
    (typeof status === "number" && status >= 500 && status < 600)
  );
}

function isOpenAICodexScopeContext(raw: string, provider?: string): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  return (
    normalizedProvider === "openai-codex" ||
    /\bopenai\s+codex\b/i.test(raw) ||
    /\bcodex\b.*\bscopes?\b/i.test(raw)
  );
}

function isAuthScopeErrorMessage(raw: string, status?: number, provider?: string): boolean {
  if (!raw) {
    return false;
  }
  if (!isOpenAICodexScopeContext(raw, provider)) {
    return false;
  }
  const inferred =
    typeof status === "number" && Number.isFinite(status)
      ? status
      : extractLeadingHttpStatus(raw.trim())?.code;
  const hasScopeHint = AUTH_SCOPE_HINT_RE.test(raw);
  const hasKnownScopeName = AUTH_SCOPE_NAME_RE.test(raw);
  if (!hasScopeHint && !hasKnownScopeName) {
    return false;
  }
  if (typeof inferred !== "number") {
    return hasScopeHint;
  }
  if (inferred !== 401 && inferred !== 403) {
    return false;
  }
  return true;
}

function isProxyErrorMessage(raw: string, status?: number): boolean {
  if (!raw) {
    return false;
  }
  if (status === 407) {
    return true;
  }
  return PROXY_ERROR_RE.test(raw);
}

function isDnsTransportErrorMessage(raw: string): boolean {
  return DNS_ERROR_RE.test(raw);
}

function isReplayInvalidErrorMessage(raw: string): boolean {
  return REPLAY_INVALID_RE.test(raw);
}

function isSandboxBlockedErrorMessage(raw: string): boolean {
  return Boolean(formatExecDeniedUserMessage(raw)) || SANDBOX_BLOCKED_RE.test(raw);
}

function isSchemaErrorMessage(raw: string): boolean {
  if (!raw || isReplayInvalidErrorMessage(raw) || isContextOverflowError(raw)) {
    return false;
  }
  return classifyFailoverReason(raw) === "format" || matchesFormatErrorPattern(raw);
}

function isTimeoutTransportErrorMessage(raw: string, status?: number): boolean {
  if (!raw) {
    return false;
  }
  if (isTimeoutErrorMessage(raw) || INTERRUPTED_NETWORK_ERROR_RE.test(raw)) {
    return true;
  }
  if (
    typeof status === "number" &&
    [408, 499, 500, 502, 503, 504, 521, 522, 523, 524, 529].includes(status)
  ) {
    return true;
  }
  return false;
}

function isOAuthRefreshTimeoutMessage(raw: string): boolean {
  return /\boauth refresh call\b.*\bexceeded hard timeout\b/i.test(raw);
}

function isOAuthRefreshContentionMessage(raw: string): boolean {
  return (
    /\brefresh_contention\b/i.test(raw) ||
    (/\bfile lock timeout\b/i.test(raw) &&
      /(?:\/|\\|^)(?:oauth-refresh|openclaw-oauth-refresh)[^/\n\\]*?(?:\.lock)?\b/i.test(raw))
  );
}

function isOAuthCallbackTimeoutMessage(raw: string): boolean {
  return /\bcallback_timeout\b/i.test(raw);
}

function isOAuthCallbackValidationMessage(raw: string): boolean {
  return /\bcallback_validation_failed\b/i.test(raw);
}
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

function classifyFailoverReasonFrom402Text(raw: string): PaymentRequiredFailoverReason | null {
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

function toReasonClassification(reason: FailoverReason): FailoverClassification {
  return { kind: "reason", reason };
}

function failoverReasonFromClassification(
  classification: FailoverClassification | null,
): FailoverReason | null {
  return classification?.kind === "reason" ? classification.reason : null;
}

export function isTransientHttpError(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const status = extractLeadingHttpStatus(trimmed);
  if (!status) {
    return false;
  }
  return TRANSIENT_HTTP_ERROR_CODES.has(status.code);
}

export function classifyFailoverReasonFromHttpStatus(
  status: number | undefined,
  message?: string,
  opts?: { provider?: string },
): FailoverReason | null {
  const messageClassification = message
    ? classifyFailoverClassificationFromMessage(message, opts?.provider)
    : null;
  return failoverReasonFromClassification(
    classifyFailoverClassificationFromHttpStatus(status, message, messageClassification, status),
  );
}

function classifyFailoverClassificationFromHttpStatus(
  status: number | undefined,
  message: string | undefined,
  messageClassification: FailoverClassification | null,
  explicitStatus: number | undefined,
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
    return toReasonClassification("rate_limit");
  }
  if (status === 401 || status === 403) {
    if (message && isAuthPermanentErrorMessage(message)) {
      return toReasonClassification("auth_permanent");
    }
    // billing message on 401/403 takes precedence over generic auth (e.g. OpenRouter
    // "Key limit exceeded" 401/403 should trigger model fallback, not auth)
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
  if (status === 404) {
    if (messageClassification?.kind === "context_overflow") {
      return messageClassification;
    }
    if (
      messageReason === "session_expired" ||
      messageReason === "billing" ||
      messageReason === "auth_permanent" ||
      messageReason === "auth"
    ) {
      return messageClassification;
    }
    return toReasonClassification("model_not_found");
  }
  if (status === 503) {
    if (messageReason === "overloaded") {
      return messageClassification;
    }
    return toReasonClassification("timeout");
  }
  if (status === 499) {
    if (messageReason === "overloaded") {
      return messageClassification;
    }
    return toReasonClassification("timeout");
  }
  if (status === 500 || status === 502 || status === 504) {
    return toReasonClassification("timeout");
  }
  if (status === 529) {
    return toReasonClassification("overloaded");
  }
  if (status === 400 || status === 422) {
    // 400/422 are ambiguous: inspect the payload first so provider-specific
    // rate limits, auth failures, model-not-found errors, and billing signals
    // are not collapsed into generic "format" failures.
    if (messageClassification) {
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

function classifyFailoverReasonFromCode(raw: string | undefined): FailoverReason | null {
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
    case "OVERLOADED":
    case "OVERLOADED_ERROR":
      return "overloaded";
    default:
      return TIMEOUT_ERROR_CODES.has(normalized) ? "timeout" : null;
  }
}

function isProvider(provider: string | undefined, match: string): boolean {
  const normalized = normalizeOptionalLowercaseString(provider);
  return Boolean(normalized && normalized.includes(match));
}

// pi-ai providers throw `Error("An unknown error occurred")` provider-agnostically
// (anthropic, google, vertex, openai-completions, mistral, bedrock, etc.) when a
// stream ends with stopReason === "aborted" | "error" without specific info. Treat
// it as a transient transport failure so the configured fallback chain rotates
// instead of returning the bare string to the user (#71620).
function isGenericUnknownStreamError(raw: string): boolean {
  return /^\s*an unknown error occurred\.?\s*$/i.test(raw);
}

function isOpenRouterProviderReturnedError(raw: string, provider?: string): boolean {
  return (
    isProvider(provider, "openrouter") &&
    (normalizeOptionalLowercaseString(raw)?.includes("provider returned error") ?? false)
  );
}

function isOpenRouterKeyLimitExceededError(raw: string, provider?: string): boolean {
  return (
    isProvider(provider, "openrouter") && /\bkey\s+limit\s*(?:exceeded|reached|hit)\b/i.test(raw)
  );
}

function isExactUnknownNoDetailsError(raw: string): boolean {
  return (
    normalizeOptionalLowercaseString(raw)?.trim() === "unknown error (no error details in response)"
  );
}

function classifyFailoverClassificationFromMessage(
  raw: string,
  provider?: string,
): FailoverClassification | null {
  if (isImageDimensionErrorMessage(raw)) {
    return null;
  }
  if (isImageSizeError(raw)) {
    return null;
  }
  if (isCliSessionExpiredErrorMessage(raw)) {
    return toReasonClassification("session_expired");
  }
  if (isModelNotFoundErrorMessage(raw)) {
    return toReasonClassification("model_not_found");
  }
  if (isContextOverflowError(raw)) {
    return { kind: "context_overflow" };
  }
  const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
  if (reasonFrom402Text) {
    return toReasonClassification(reasonFrom402Text);
  }
  if (isOpenRouterKeyLimitExceededError(raw, provider)) {
    return toReasonClassification("billing");
  }
  if (isPeriodicUsageLimitErrorMessage(raw)) {
    return toReasonClassification(isBillingErrorMessage(raw) ? "billing" : "rate_limit");
  }
  if (isRateLimitErrorMessage(raw)) {
    return toReasonClassification("rate_limit");
  }
  if (isOverloadedErrorMessage(raw)) {
    return toReasonClassification("overloaded");
  }
  if (isTransientHttpError(raw)) {
    const status = extractLeadingHttpStatus(raw.trim());
    if (status?.code === 529) {
      return toReasonClassification("overloaded");
    }
    return toReasonClassification("timeout");
  }
  // Billing and auth classifiers run before the broad isJsonApiInternalServerError
  // check so that provider errors like {"type":"api_error","message":"insufficient
  // balance"} are correctly classified as "billing"/"auth" rather than "timeout".
  if (isBillingErrorMessage(raw)) {
    return toReasonClassification("billing");
  }
  if (isAuthPermanentErrorMessage(raw)) {
    return toReasonClassification("auth_permanent");
  }
  if (isAuthErrorMessage(raw)) {
    return toReasonClassification("auth");
  }
  if (isGenericUnknownStreamError(raw)) {
    return toReasonClassification("timeout");
  }
  if (isOpenRouterProviderReturnedError(raw, provider)) {
    return toReasonClassification("timeout");
  }
  if (isServerErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  if (isJsonApiInternalServerError(raw)) {
    return toReasonClassification("timeout");
  }
  if (isCloudCodeAssistFormatError(raw)) {
    return toReasonClassification("format");
  }
  if (isExactUnknownNoDetailsError(raw)) {
    return toReasonClassification("no_error_details");
  }
  if (isTimeoutErrorMessage(raw)) {
    return toReasonClassification("timeout");
  }
  // Provider-specific patterns as a final catch (Bedrock, Groq, Together AI, etc.)
  const providerSpecific = classifyProviderSpecificError(raw);
  if (providerSpecific) {
    return toReasonClassification(providerSpecific);
  }
  return null;
}

export function classifyFailoverSignal(signal: FailoverSignal): FailoverClassification | null {
  const inferredStatus = inferSignalStatus(signal);
  if (
    signal.message &&
    isTransportHtmlErrorStatus(inferredStatus) &&
    isHtmlErrorResponse(signal.message, inferredStatus)
  ) {
    return toReasonClassification("timeout");
  }
  const messageClassification = signal.message
    ? classifyFailoverClassificationFromMessage(signal.message, signal.provider)
    : null;
  const statusClassification = classifyFailoverClassificationFromHttpStatus(
    inferredStatus,
    signal.message,
    messageClassification,
    signal.status,
  );
  if (statusClassification) {
    return statusClassification;
  }
  const codeReason = classifyFailoverReasonFromCode(signal.code);
  if (codeReason) {
    return toReasonClassification(codeReason);
  }
  return messageClassification;
}

export function classifyProviderRuntimeFailureKind(
  signal: FailoverSignal | string,
): ProviderRuntimeFailureKind {
  const normalizedSignal = typeof signal === "string" ? { message: signal } : signal;
  const message = normalizedSignal.message?.trim() ?? "";
  const status = inferSignalStatus(normalizedSignal);

  if (!message && typeof status !== "number") {
    return "empty_response";
  }
  if (normalizedSignal.code === "refresh_contention") {
    return "refresh_contention";
  }
  if (message && isOAuthRefreshContentionMessage(message)) {
    return "refresh_contention";
  }
  if (message && isOAuthRefreshTimeoutMessage(message)) {
    return "refresh_timeout";
  }
  if (message && isOAuthCallbackTimeoutMessage(message)) {
    return "callback_timeout";
  }
  if (message && isOAuthCallbackValidationMessage(message)) {
    return "callback_validation";
  }
  if (message && classifyOAuthRefreshFailure(message)) {
    return "auth_refresh";
  }
  if (message && isAuthScopeErrorMessage(message, status, normalizedSignal.provider)) {
    return "auth_scope";
  }
  if (message && isProxyErrorMessage(message, status)) {
    return "proxy";
  }
  if (message && isHtmlErrorResponse(message, status)) {
    return status === 403 ? "auth_html_403" : "upstream_html";
  }
  const failoverClassification = classifyFailoverSignal({
    ...normalizedSignal,
    status,
    message: message || undefined,
  });
  if (failoverClassification?.kind === "reason" && failoverClassification.reason === "rate_limit") {
    return "rate_limit";
  }
  if (message && isDnsTransportErrorMessage(message)) {
    return "dns";
  }
  if (message && isSandboxBlockedErrorMessage(message)) {
    return "sandbox_blocked";
  }
  if (message && isReplayInvalidErrorMessage(message)) {
    return "replay_invalid";
  }
  if (message && isSchemaErrorMessage(message)) {
    return "schema";
  }
  if (
    failoverClassification?.kind === "reason" &&
    (failoverClassification.reason === "timeout" || failoverClassification.reason === "overloaded")
  ) {
    return "timeout";
  }
  if (message && isTimeoutTransportErrorMessage(message, status)) {
    return "timeout";
  }
  if (message && isExactUnknownNoDetailsError(message)) {
    return "no_error_details";
  }
  return "unclassified";
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: { cfg?: OpenClawConfig; sessionKey?: string; provider?: string; model?: string },
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) {
    return undefined;
  }
  if (!raw) {
    return "LLM request failed with an unknown error.";
  }

  const providerRuntimeFailureKind = classifyProviderRuntimeFailureKind({
    status: extractLeadingHttpStatus(raw)?.code,
    message: raw,
    provider: opts?.provider ?? msg.provider,
  });

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) {
      return rewritten;
    }
  }

  const diskSpaceCopy = formatDiskSpaceErrorCopy(raw);
  if (diskSpaceCopy) {
    return diskSpaceCopy;
  }

  if (providerRuntimeFailureKind === "auth_refresh") {
    return "Authentication refresh failed. Re-authenticate this provider and try again.";
  }

  if (providerRuntimeFailureKind === "refresh_contention") {
    return (
      "Authentication refresh is already in progress elsewhere and this attempt " +
      "timed out waiting for it. Retry in a moment."
    );
  }

  if (providerRuntimeFailureKind === "refresh_timeout") {
    return (
      "Authentication refresh timed out before the provider completed. " +
      "Retry in a moment; re-authenticate only if it keeps failing."
    );
  }

  if (providerRuntimeFailureKind === "callback_timeout") {
    return (
      "Browser OAuth did not complete before manual fallback kicked in. " +
      "Retry the login flow and paste the redirect URL if prompted."
    );
  }

  if (providerRuntimeFailureKind === "callback_validation") {
    return (
      "Browser OAuth returned an invalid or incomplete callback. " +
      "Retry the login flow and make sure the full redirect URL is pasted if prompted."
    );
  }

  if (providerRuntimeFailureKind === "auth_scope") {
    return (
      "Authentication is missing the required OpenAI Codex scopes. " +
      "Re-run OpenAI/Codex login and try again."
    );
  }

  if (providerRuntimeFailureKind === "auth_html_403") {
    return (
      "Authentication failed with an HTML 403 response from the provider. " +
      "Re-authenticate and verify your provider account access."
    );
  }

  if (providerRuntimeFailureKind === "upstream_html") {
    return (
      "The provider returned an HTML error page instead of an API response. " +
      "This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. " +
      "Retry in a moment or check provider status."
    );
  }

  if (providerRuntimeFailureKind === "proxy") {
    return "LLM request failed: proxy or tunnel configuration blocked the provider request.";
  }

  if (isContextOverflowError(raw)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try /reset (or /new) to start a fresh session, or use a larger-context model."
    );
  }

  if (isReasoningConstraintErrorMessage(raw)) {
    return (
      "Reasoning is required for this model endpoint. " +
      "Use /think minimal (or any non-off level) and try again."
    );
  }

  if (isInvalidStreamingEventOrderError(raw)) {
    return "LLM request failed: provider returned an invalid streaming response. Please try again.";
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (isMissingToolCallInputError(raw)) {
    return (
      "Session history looks corrupted (tool call input missing). " +
      "Use /new to start a fresh session. " +
      "If this keeps happening, reset the session or delete the corrupted session transcript."
    );
  }

  const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  const transientCopy = formatRateLimitOrOverloadedErrorCopy(raw);
  if (transientCopy) {
    return transientCopy;
  }

  const transportCopy = formatTransportErrorCopy(raw);
  if (transportCopy) {
    return transportCopy;
  }

  if (isTimeoutErrorMessage(raw)) {
    return "LLM request timed out.";
  }

  if (isBillingErrorMessage(raw)) {
    return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model);
  }

  if (providerRuntimeFailureKind === "schema") {
    return "LLM request failed: provider rejected the request schema or tool payload.";
  }

  if (providerRuntimeFailureKind === "replay_invalid") {
    return (
      "Session history or replay state is invalid. " +
      "Use /new to start a fresh session and try again."
    );
  }

  if (isLikelyHttpErrorText(raw) || isRawApiErrorPayload(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  // Never return raw unhandled errors - log for debugging but return safe message
  if (raw.length > 600) {
    log.warn(`Long error truncated: ${raw.slice(0, 200)}`);
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}

const TOOL_CALL_INPUT_MISSING_RE =
  /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE =
  /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;

const IMAGE_DIMENSION_ERROR_RE =
  /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;

export function isMissingToolCallInputError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  return TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw);
}

export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isBillingErrorMessage(msg.errorMessage ?? "");
}

// Transient signal patterns for api_error payloads. Only treat an api_error as
// retryable when the message text itself indicates a transient server issue.
// Non-transient api_error payloads (context overflow, validation/schema errors)
// must NOT be classified as timeout.
const API_ERROR_TRANSIENT_SIGNALS_RE =
  /internal server error|overload|temporarily unavailable|service unavailable|unknown error|server error|bad gateway|gateway timeout|upstream error|backend error|try again later|temporarily.+unable|unexpected error/i;

function isJsonApiInternalServerError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  // Providers wrap transient 5xx errors in JSON payloads like:
  // {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
  // Non-standard providers (e.g. MiniMax) may use different message text:
  // {"type":"api_error","message":"unknown error, 520 (1000)"}
  if (!value.includes('"type":"api_error"')) {
    return false;
  }
  // Billing and auth errors can also carry "type":"api_error". Exclude them so
  // the more specific classifiers further down the chain handle them correctly.
  if (isBillingErrorMessage(raw) || isAuthErrorMessage(raw) || isAuthPermanentErrorMessage(raw)) {
    return false;
  }
  // Only match when the message contains a transient signal. api_error payloads
  // with non-transient messages (e.g. context overflow, schema validation) should
  // fall through to more specific classifiers or remain unclassified.
  return API_ERROR_TRANSIENT_SIGNALS_RE.test(raw);
}

export function parseImageDimensionError(raw: string): {
  maxDimensionPx?: number;
  messageIndex?: number;
  contentIndex?: number;
  raw: string;
} | null {
  if (!raw) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!lower.includes("image dimensions exceed max allowed size")) {
    return null;
  }
  const limitMatch = raw.match(IMAGE_DIMENSION_ERROR_RE);
  const pathMatch = raw.match(IMAGE_DIMENSION_PATH_RE);
  return {
    maxDimensionPx: limitMatch?.[1] ? Number.parseInt(limitMatch[1], 10) : undefined,
    messageIndex: pathMatch?.[1] ? Number.parseInt(pathMatch[1], 10) : undefined,
    contentIndex: pathMatch?.[2] ? Number.parseInt(pathMatch[2], 10) : undefined,
    raw,
  };
}

export function isImageDimensionErrorMessage(raw: string): boolean {
  return Boolean(parseImageDimensionError(raw));
}

export function parseImageSizeError(raw: string): {
  maxMb?: number;
  raw: string;
} | null {
  if (!raw) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!lower.includes("image exceeds") || !lower.includes("mb")) {
    return null;
  }
  const match = raw.match(IMAGE_SIZE_ERROR_RE);
  return {
    maxMb: match?.[1] ? Number.parseFloat(match[1]) : undefined,
    raw,
  };
}

export function isImageSizeError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  return Boolean(parseImageSizeError(errorMessage));
}

export function isCloudCodeAssistFormatError(raw: string): boolean {
  return !isImageDimensionErrorMessage(raw) && matchesFormatErrorPattern(raw);
}

export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

export { isModelNotFoundErrorMessage };

function isCliSessionExpiredErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("session not found") ||
    lower.includes("session does not exist") ||
    lower.includes("session expired") ||
    lower.includes("session invalid") ||
    lower.includes("conversation not found") ||
    lower.includes("no conversation found") ||
    lower.includes("conversation does not exist") ||
    lower.includes("conversation expired") ||
    lower.includes("conversation invalid") ||
    lower.includes("no such session") ||
    lower.includes("invalid session") ||
    lower.includes("session id not found") ||
    lower.includes("conversation id not found")
  );
}

export function classifyFailoverReason(
  raw: string,
  opts?: { provider?: string },
): FailoverReason | null {
  return failoverReasonFromClassification(
    classifyFailoverSignal({
      message: raw,
      provider: opts?.provider,
    }),
  );
}

export function isFailoverErrorMessage(raw: string, opts?: { provider?: string }): boolean {
  return classifyFailoverReason(raw, opts) !== null;
}

export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isFailoverErrorMessage(msg.errorMessage ?? "", { provider: msg.provider });
}
