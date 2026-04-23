import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

type ErrorPattern = RegExp | string;

const PERIODIC_USAGE_LIMIT_RE =
  /\b(?:daily|weekly|monthly)(?:\/(?:daily|weekly|monthly))* (?:usage )?limit(?:s)?(?: (?:exhausted|reached|exceeded))?\b/i;

const HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS = [
  /api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)/i,
  "key has been disabled",
  "key has been revoked",
  "account has been deactivated",
  "not allowed for this organization",
] as const satisfies readonly ErrorPattern[];

const AMBIGUOUS_AUTH_ERROR_PATTERNS = [
  /invalid[_ ]?api[_ ]?key/,
  /could not (?:authenticate|validate).*(?:api[_ ]?key|credentials)/i,
  "permission_error",
] as const satisfies readonly ErrorPattern[];

const COMMON_AUTH_ERROR_PATTERNS = [
  "incorrect api key",
  "invalid token",
  "authentication",
  "re-authenticate",
  "oauth token refresh failed",
  "unauthorized",
  "forbidden",
  "access denied",
  "insufficient permissions",
  "insufficient permission",
  /missing scopes?:/i,
  "expired",
  "token has expired",
  /\b401\b/,
  /\b403\b/,
  "no credentials found",
  "no api key found",
  /\bfailed to (?:extract|parse|validate|decode)\b.*\btoken\b/,
] as const satisfies readonly ErrorPattern[];

const ZAI_BILLING_CODE_1311_RE = /"code"\s*:\s*1311\b/;
const ZAI_AUTH_CODE_1113_RE = /"code"\s*:\s*1113\b/;
const STATUS_INTERNAL_SERVER_ERROR_RE = /\bstatus:\s*internal server error\b/i;
const STATUS_INTERNAL_SERVER_ERROR_WITH_500_RE =
  /^(?=[\s\S]*\bstatus:\s*internal server error\b)(?=[\s\S]*\bcode["']?\s*[:=]\s*500\b)/i;

const ZAI_AUTH_ERROR_PATTERNS = [
  // Z.ai: error 1113 = wrong endpoint or invalid credentials (#48988)
  ZAI_AUTH_CODE_1113_RE,
] as const satisfies readonly ErrorPattern[];

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    /too many (?:concurrent )?requests/i,
    /throttling(?:exception)?/i,
    "model_cooldown",
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "throttlingexception",
    "throttling_exception",
    "throttled",
    "throttling",
    "usage limit",
    /\btpm\b/i,
    "tokens per minute",
    "tokens per day",
  ],
  overloaded: [
    /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
    "overloaded",
    // Match "service unavailable" only when combined with an explicit overload
    // indicator — a generic 503 from a proxy/CDN should not be classified as
    // provider-overload (#32828).
    /service[_ ]unavailable.*(?:overload|capacity|high[_ ]demand)|(?:overload|capacity|high[_ ]demand).*service[_ ]unavailable/i,
    "high demand",
  ],
  serverError: [
    "an error occurred while processing",
    "internal server error",
    "internal_error",
    "server_error",
    "service temporarily unavailable",
    "service_unavailable",
    "bad gateway",
    "gateway timeout",
    "upstream error",
    "upstream connect error",
    "connection reset",
  ],
  timeout: [
    "timeout",
    "timed out",
    "service unavailable",
    "deadline exceeded",
    "context deadline exceeded",
    /^(?=[\s\S]*\bgot status:\s*internal\b)(?=[\s\S]*\bcode["']?\s*[:=]\s*500\b)/i,
    /^(?=[\s\S]*["']status["']\s*:\s*["']internal["'])(?=[\s\S]*["']code["']\s*:\s*500\b)/i,
    "connection error",
    "network error",
    "network request failed",
    "fetch failed",
    "socket hang up",
    /\beconn(?:refused|reset|aborted)\b/i,
    /\benetunreach\b/i,
    /\behostunreach\b/i,
    /\behostdown\b/i,
    /\benetreset\b/i,
    /\betimedout\b/i,
    /\besockettimedout\b/i,
    /\bepipe\b/i,
    /\benotfound\b/i,
    /\beai_again\b/i,
    /without sending (?:any )?chunks?/i,
    /\bstop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    /\breason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    /\bunhandled stop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    // `\breason:` does not match provider payloads like `finish_reason: network_error` (#61281).
    /\bfinish_reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    // AbortError messages from fetch/stream aborts (Ollama NDJSON stream
    // timeouts, signal aborts, etc.) — without these the flattened message
    // falls through to reason=unknown (#58315).
    /\boperation was aborted\b/i,
    /\bstream (?:was )?(?:closed|aborted)\b/i,
    // Undici transport-level failures during CDN/provider outages (Cloudflare
    // 502 served with an empty body, socket reset mid-response, body-stream
    // aborted). These arrive as bare strings on the outer error and, without
    // an explicit match, the fallback chain is never attempted (#69368).
    /^terminated$/i,
    /\bund_err_(?:socket|connect|headers?|body|req_content_length_mismatch|aborted|closed)\b/i,
    // pi-ai's openai-codex provider surfaces `Request failed` when the HTTP
    // response has no body and no status text (typical of Cloudflare 502s
    // from the upstream Codex service). Treat it as a transport failure so
    // the configured fallback chain runs instead of surfacing the error.
    /^request failed$/i,
    /\brequest failed after repeated internal retries\b/i,
  ],
  billing: [
    /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment/i,
    "payment required",
    "insufficient credits",
    /insufficient[_ ]quota/i,
    "credit balance",
    "plans & billing",
    "insufficient balance",
    "insufficient usd or diem balance",
    /requires?\s+more\s+credits/i,
    /out of extra usage/i,
    /draw from your extra usage/i,
    /extra usage is required(?: for long context requests)?/i,
    // Z.ai: error 1311 = model not included in current subscription plan (#48988)
    ZAI_BILLING_CODE_1311_RE,
  ],
  authPermanent: HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS,
  auth: [
    ...AMBIGUOUS_AUTH_ERROR_PATTERNS,
    ...COMMON_AUTH_ERROR_PATTERNS,
    ...ZAI_AUTH_ERROR_PATTERNS,
  ],
  format: [
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
    /tool call id was.*must be/i,
  ],
} as const;

const BILLING_ERROR_HEAD_RE =
  /^(?:error[:\s-]+)?billing(?:\s+error)?(?:[:\s-]+|$)|^(?:error[:\s-]+)?(?:credit balance|insufficient credits?|payment required|http\s*402\b)/i;
const BILLING_ERROR_HARD_402_RE =
  /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|^\s*402\s+payment/i;
const BILLING_ERROR_MAX_LENGTH = 512;

function matchesErrorPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  if (!raw) {
    return false;
  }
  const value = normalizeLowercaseStringOrEmpty(raw);
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

function matchesErrorPatternGroups(
  raw: string,
  groups: readonly (readonly ErrorPattern[])[],
): boolean {
  return groups.some((patterns) => matchesErrorPatterns(raw, patterns));
}

export function matchesFormatErrorPattern(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

export function isPeriodicUsageLimitErrorMessage(raw: string): boolean {
  return PERIODIC_USAGE_LIMIT_RE.test(raw);
}

export function isBillingErrorMessage(raw: string): boolean {
  const value = normalizeLowercaseStringOrEmpty(raw);
  if (!value) {
    return false;
  }

  if (raw.length > BILLING_ERROR_MAX_LENGTH) {
    return BILLING_ERROR_HARD_402_RE.test(value) || ZAI_BILLING_CODE_1311_RE.test(value);
  }
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) {
    return true;
  }
  if (!BILLING_ERROR_HEAD_RE.test(raw)) {
    return false;
  }
  return (
    value.includes("upgrade") ||
    value.includes("credits") ||
    value.includes("payment") ||
    value.includes("purchase") ||
    value.includes("subscription") ||
    value.includes("plan")
  );
}

export function isAuthPermanentErrorMessage(raw: string): boolean {
  return matchesErrorPatternGroups(raw, [HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS]);
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatternGroups(raw, [
    AMBIGUOUS_AUTH_ERROR_PATTERNS,
    COMMON_AUTH_ERROR_PATTERNS,
    ZAI_AUTH_ERROR_PATTERNS,
  ]);
}

export function isOverloadedErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}

export function isServerErrorMessage(raw: string): boolean {
  const value = normalizeLowercaseStringOrEmpty(raw);
  if (!value) {
    return false;
  }
  if (STATUS_INTERNAL_SERVER_ERROR_WITH_500_RE.test(value)) {
    return true;
  }
  const scrubbed = value.replace(STATUS_INTERNAL_SERVER_ERROR_RE, "").trim();
  return scrubbed.length > 0 && matchesErrorPatterns(scrubbed, ERROR_PATTERNS.serverError);
}
