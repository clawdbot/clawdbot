import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";
import { extractHttpResponseBody } from "../../shared/http-error-response.js";
import { classifyOAuthRefreshFailure } from "../auth-profiles/oauth-refresh-failure.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import {
  inferSignalStatus,
  isExactUnknownNoDetailsError,
} from "../failover/classification-rules.js";
import { classifyFailoverReason, classifyFailoverSignal } from "../failover/classify.js";
import { isContextOverflowErrorFromTables } from "../failover/context-overflow.js";
import { matchesFormatErrorPattern, isTimeoutErrorMessage } from "../failover/message-patterns.js";
import type { FailoverSignal } from "../failover/signal.js";
export type ProviderRuntimeFailureKind =
  | "auth_scope"
  | "auth_refresh"
  | "refresh_timeout"
  | "refresh_contention"
  | "callback_timeout"
  | "callback_validation"
  | "auth_html"
  /** Plain provider HTTP 401 auth failure that should not leak raw text to chat users. */
  | "auth_invalid_token"
  | "upstream_html"
  | "proxy"
  | "rate_limit"
  | "dns"
  | "timeout"
  | "tls_certificate"
  | "model_not_found"
  | "schema"
  | "sandbox_blocked"
  | "replay_invalid"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";
const AUTH_SCOPE_HINT_RE =
  /\b(?:missing|required|requires|insufficient)\s+(?:the\s+following\s+)?scopes?\b|\bmissing\s+scope\b/i;
const AUTH_SCOPE_NAME_RE = /\b(?:api\.responses\.write|model\.request)\b/i;
const AUTH_INVALID_TOKEN_HINT_RE =
  /\bunauthorized\b|\b(?:invalid|incorrect|expired|stale)[_\s-]?api[_\s-]?key\b|\b(?:invalid|incorrect|expired|stale)\s+(?:token|jwt|credential|api[_\s-]?key)\b|\b(?:token|jwt|credential|api[_\s-]?key)\s+(?:is\s+)?(?:invalid|incorrect|expired|stale)\b/i;
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
const CLOUDFLARE_CHALLENGE_RE =
  /Enable\s+JavaScript\s+and\s+cookies\s+to\s+continue|cf-browser-verification|__cf_challenge|cdn-cgi\/challenge-platform|challenge-error-text/i;
const PROXY_ERROR_RE =
  /\bproxyconnect\b|\bhttps?_proxy\b|\b407\b|\bproxy authentication required\b|\btunnel connection failed\b|\bconnect tunnel\b|\bsocks proxy\b|\bproxy error\b/i;
const DNS_ERROR_RE = /\benotfound\b|\beai_again\b|\bgetaddrinfo\b|\bno such host\b|\bdns\b/i;
const INTERRUPTED_NETWORK_ERROR_RE =
  /\beconnrefused\b|\beconnreset\b|\beconnaborted\b|\benetreset\b|\behostunreach\b|\behostdown\b|\benetunreach\b|\bepipe\b|\bsocket hang up\b|\bconnection refused\b|\bconnection reset\b|\bconnection aborted\b|\bnetwork is unreachable\b|\bhost is unreachable\b|\bfetch failed\b|\bconnection error\b|\bnetwork request failed\b/i;
const REPLAY_INVALID_RE =
  /\bprevious_response_id\b.*\b(?:invalid|unknown|not found|does not exist|expired|mismatch)\b|\btool_(?:use|call)\.(?:input|arguments)\b.*\b(?:missing|required)\b|\bincorrect role information\b|\broles must alternate\b|\binput item id does not belong to this connection\b/i;
const THINKING_SIGNATURE_ERROR_RE =
  /\b(?:invalid|expired)\b.*\bsignature\b|\bsignature\b.*\b(?:invalid|expired)\b/i;
const SANDBOX_BLOCKED_RE =
  /\bapproval is required\b|\bapproval timed out\b|\bapproval was denied\b|\bblocked by sandbox\b|\bsandbox\b.*\b(?:blocked|denied|forbidden|disabled|not allowed)\b|\bexec denied\s*\(/i;
function stripErrorPrefix(raw: string): string {
  return raw.replace(/^error:\s*/i, "").trim();
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
  const rest = extractHttpResponseBody(extractLeadingHttpStatus(candidate))?.body ?? candidate;
  return HTML_BODY_RE.test(rest) && HTML_CLOSE_RE.test(rest);
}
function isCloudflareChallengeResponse(message: string): boolean {
  return CLOUDFLARE_CHALLENGE_RE.test(message);
}
function isOpenAICodexScopeContext(raw: string, provider?: string): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  return (
    normalizedProvider === "openai" ||
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
  return REPLAY_INVALID_RE.test(raw) || isThinkingSignatureReplayInvalidErrorMessage(raw);
}
function isThinkingSignatureReplayInvalidErrorMessage(raw: string): boolean {
  return /\bthinking\b/i.test(raw) && THINKING_SIGNATURE_ERROR_RE.test(raw);
}
function isSandboxBlockedErrorMessage(raw: string): boolean {
  return Boolean(formatExecDeniedUserMessage(raw)) || SANDBOX_BLOCKED_RE.test(raw);
}
function isSchemaErrorMessage(raw: string): boolean {
  if (!raw || isReplayInvalidErrorMessage(raw) || isContextOverflowErrorFromTables(raw)) {
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
export function classifyProviderRuntimeFailureKind(
  signal: FailoverSignal | string,
): ProviderRuntimeFailureKind {
  const normalizedSignal = typeof signal === "string" ? { message: signal } : signal;
  const message = normalizedSignal.message?.trim() ?? "";
  const status = inferSignalStatus(normalizedSignal);
  const hasStructuredErrorSignal = Boolean(normalizedSignal.code || normalizedSignal.errorType);
  if (!message && typeof status !== "number" && !hasStructuredErrorSignal) {
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
    // Cloudflare challenge pages block programmatic requests at the CDN layer.
    // These are upstream gateway blocks, not authentication failures — surface
    // the more accurate "upstream_html" message, which already mentions
    // "CDN or gateway (e.g. Cloudflare) blocked the request".
    if (status === 403 && isCloudflareChallengeResponse(message)) {
      return "upstream_html";
    }
    return status === 401 || status === 403 ? "auth_html" : "upstream_html";
  }
  const failoverClassification = classifyFailoverSignal({
    ...normalizedSignal,
    status,
    message: message || undefined,
  });
  const failoverReason =
    failoverClassification?.kind === "reason" ? failoverClassification.reason : undefined;
  switch (failoverReason) {
    case "tls_certificate":
    case "rate_limit":
    case "model_not_found":
      return failoverReason;
    default:
      break;
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
  // Plain HTTP 401 / invalid-token replies should be safe chat copy, but the
  // same failover reason also covers plain 403 and status-less auth payloads.
  // Require positive 401 evidence so we do not claim the wrong HTTP status.
  const messageMentions401 = /\b401\b/.test(message);
  const messageMentions403 = /\b403\b/.test(message);
  const has401Evidence =
    status === 401 || (status === undefined && messageMentions401 && !messageMentions403);
  const hasPermissionScopeSignal =
    AUTH_SCOPE_HINT_RE.test(message) || AUTH_SCOPE_NAME_RE.test(message);
  if (
    failoverReason === "auth" &&
    has401Evidence &&
    AUTH_INVALID_TOKEN_HINT_RE.test(message) &&
    !hasPermissionScopeSignal
  ) {
    return "auth_invalid_token";
  }
  if (failoverReason === "timeout" || failoverReason === "overloaded") {
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
