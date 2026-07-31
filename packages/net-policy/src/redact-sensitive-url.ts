// Network Policy module implements redact sensitive url behavior.
type ConfigUiHintTags = {
  tags?: string[];
};

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Config UI hint tag for URL-like values that may embed credentials or tokens. */
export const SENSITIVE_URL_HINT_TAG = "url-secret";

const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
  "token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "access_token",
  "auth_token",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "id_token",
  "code",
  "client_secret",
  "app_secret",
  "hook_token",
  "refresh_token",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "private_key",
  "credential",
  "authorization",
]);
// Align with FORM_BODY_KEY_SEPARATOR_RE: category-Lo Hangul fillers can splice sensitive names.
const URL_QUERY_NAME_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;

// Telegram bot credentials use `/bot<token>/...`; align this shape with logging/redact.ts.
const TELEGRAM_BOT_TOKEN_PATH_RE = /\/bot\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\/|$)/giu;
// Bound recursive decoding so hostile nested callbacks cannot grow work without limit.
const MAX_NESTED_URL_REDACTION_DEPTH = 8;
const URL_SCHEME_RE = /(?:^|[^a-z\d+.-])[a-z][a-z\d+.-]{0,31}:/iu;
const SPECIAL_SCHEME_AUTHORITY_RE = /\b(?:https?|wss?|ftp):[\\/]{0,2}[^\\/?#\s]*/giu;
const SPECIAL_SCHEME_SPILLED_USERINFO_RE = /\b(?:https?|wss?|ftp):[\\/]{0,2}[^\s]*@[^\\/?#\s]*/giu;
const PROTOCOL_RELATIVE_AUTHORITY_RE = /[\\/]{2,}[^\\/?#\s]*/gu;

type UrlRedactionResult = { value: string; parsedWholeUrl: boolean };

function redactSensitiveUrlPath(value: string): string {
  return value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***");
}

function normalizeUrlQueryParamName(name: string): {
  value: string;
  unresolvedEncoding: boolean;
} {
  let current = name.replace(URL_QUERY_NAME_SEPARATOR_RE, "");
  for (let depth = 0; depth <= MAX_NESTED_URL_REDACTION_DEPTH; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current).replace(URL_QUERY_NAME_SEPARATOR_RE, "");
    } catch {
      return {
        value: normalizeLowercaseStringOrEmpty(current).replaceAll("-", "_"),
        unresolvedEncoding: current.includes("%"),
      };
    }
    if (decoded === current) {
      return {
        value: normalizeLowercaseStringOrEmpty(current).replaceAll("-", "_"),
        unresolvedEncoding: false,
      };
    }
    current = decoded;
  }
  return {
    value: normalizeLowercaseStringOrEmpty(current).replaceAll("-", "_"),
    unresolvedEncoding: current.includes("%"),
  };
}

function looksLikeNestedUrlValue(value: string): boolean {
  if (URL_SCHEME_RE.test(value)) {
    return true;
  }
  const forwardAuthorityIndex = value.indexOf("//");
  const backwardAuthorityIndex = value.indexOf("\\\\");
  const authorityIndex =
    forwardAuthorityIndex < 0
      ? backwardAuthorityIndex
      : backwardAuthorityIndex < 0
        ? forwardAuthorityIndex
        : Math.min(forwardAuthorityIndex, backwardAuthorityIndex);
  if (authorityIndex >= 0 && value.includes("@", authorityIndex + 2)) {
    return true;
  }
  const queryIndex = value.search(/[?&]/u);
  if (queryIndex >= 0 && value.includes("=", queryIndex + 1)) {
    return true;
  }
  const fragmentIndex = value.indexOf("#");
  if (fragmentIndex >= 0 && value.includes("=", fragmentIndex + 1)) {
    return true;
  }
  return /%[\da-f]{2}/iu.test(value);
}

/** True for auth-like URL query parameter names that should be redacted. */
export function isSensitiveUrlQueryParamName(name: string): boolean {
  const normalized = normalizeUrlQueryParamName(name);
  return normalized.unresolvedEncoding || SENSITIVE_URL_QUERY_PARAM_NAMES.has(normalized.value);
}

/** True for config paths whose URL values may contain credentials or secret query params. */
export function isSensitiveUrlConfigPath(path: string): boolean {
  if (path.endsWith(".baseUrl") || path.endsWith(".httpUrl")) {
    return true;
  }
  if (path.endsWith(".cdpUrl")) {
    return true;
  }
  if (path.endsWith(".request.proxy.url")) {
    return true;
  }
  return /^(?:nodeHost\.)?mcp\.servers\.(?:\*|[^.]+)\.url$/.test(path);
}

/** True when a config UI hint explicitly marks a URL-like value as secret-bearing. */
export function hasSensitiveUrlHintTag(hint: ConfigUiHintTags | undefined): boolean {
  return hint?.tags?.includes(SENSITIVE_URL_HINT_TAG) === true;
}

function redactDirectSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let mutated = false;
    const redactedPath = redactSensitiveUrlPath(parsed.pathname);
    if (redactedPath !== parsed.pathname) {
      parsed.pathname = redactedPath;
      mutated = true;
    }
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
      mutated = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveUrlQueryParamName(key)) {
        parsed.searchParams.set(key, "***");
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : value;
  } catch {
    return value;
  }
}

function redactQueryString(value: string, depth: number): string {
  const params = new URLSearchParams(value);
  const entries = Array.from(params.entries());
  const redactedEntries: Array<[string, string]> = [];
  const seenSensitiveKeys = new Set<string>();
  let mutated = false;

  for (const [key, entryValue] of entries) {
    if (isSensitiveUrlQueryParamName(key)) {
      mutated = true;
      if (!seenSensitiveKeys.has(key)) {
        seenSensitiveKeys.add(key);
        redactedEntries.push([key, "***"]);
      }
      continue;
    }

    const redactedKey = redactNestedUrlValue(key, depth + 1);
    const redactedValue = redactNestedUrlValue(entryValue, depth + 1);
    if (redactedKey !== key || redactedValue !== entryValue) {
      mutated = true;
    }
    redactedEntries.push([redactedKey, redactedValue]);
  }

  if (!mutated) {
    return value;
  }
  const redactedParams = new URLSearchParams();
  for (const [key, entryValue] of redactedEntries) {
    redactedParams.append(key, entryValue);
  }
  return redactedParams.toString();
}

function redactUrlLikeFallback(value: string): string {
  const redactedFallback = redactEmbeddedUrlUserInfo(value).replace(
    /([?&])([^=&]+)=([^&]*)/g,
    (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match,
  );
  return redactSensitiveUrlPath(redactedFallback);
}

function redactAuthorityUserInfo(candidate: string, authorityStart: number): string {
  const authority = candidate.slice(authorityStart);
  const userInfoEnd = authority.lastIndexOf("@");
  if (userInfoEnd < 0) {
    return candidate;
  }
  return `${candidate.slice(0, authorityStart)}***:***@${authority.slice(userInfoEnd + 1)}`;
}

function redactEmbeddedUrlUserInfo(value: string): string {
  return value
    .replace(SPECIAL_SCHEME_AUTHORITY_RE, (candidate) => {
      let authorityStart = candidate.indexOf(":") + 1;
      while (
        authorityStart < candidate.length &&
        (candidate[authorityStart] === "/" || candidate[authorityStart] === "\\")
      ) {
        authorityStart += 1;
      }
      return redactAuthorityUserInfo(candidate, authorityStart);
    })
    .replace(SPECIAL_SCHEME_SPILLED_USERINFO_RE, (candidate) => {
      let authorityStart = candidate.indexOf(":") + 1;
      while (
        authorityStart < candidate.length &&
        (candidate[authorityStart] === "/" || candidate[authorityStart] === "\\")
      ) {
        authorityStart += 1;
      }
      const userInfoEnd = candidate.lastIndexOf("@");
      const firstReservedDelimiter = candidate.slice(authorityStart).search(/[\\/?#]/u);
      if (userInfoEnd < 0 || firstReservedDelimiter < 0) {
        return candidate;
      }
      const absoluteReservedDelimiter = authorityStart + firstReservedDelimiter;
      if (absoluteReservedDelimiter >= userInfoEnd) {
        return candidate;
      }
      const credentialSeparator = candidate.indexOf(":", authorityStart);
      if (credentialSeparator < 0 || credentialSeparator > absoluteReservedDelimiter) {
        return candidate;
      }
      const authorityPrefix = candidate.slice(authorityStart, absoluteReservedDelimiter);
      const possiblePort = candidate.slice(credentialSeparator + 1, absoluteReservedDelimiter);
      // Keep unambiguous host:port and IPv6 authorities when later URL components contain `@`.
      if (/^\d+$/u.test(possiblePort) || /^\[[^\]]+\](?::\d+)?$/u.test(authorityPrefix)) {
        return candidate;
      }
      return `${candidate.slice(0, authorityStart)}***:***@${candidate.slice(userInfoEnd + 1)}`;
    })
    .replace(PROTOCOL_RELATIVE_AUTHORITY_RE, (candidate) => {
      let authorityStart = 0;
      while (
        authorityStart < candidate.length &&
        (candidate[authorityStart] === "/" || candidate[authorityStart] === "\\")
      ) {
        authorityStart += 1;
      }
      return redactAuthorityUserInfo(candidate, authorityStart);
    });
}

function hasUnresolvedEmbeddedUrlUserInfo(value: string): boolean {
  for (const match of value.matchAll(/(?:\b(?:https?|wss?|ftp):[\\/]{0,2}|[\\/]{2,})/giu)) {
    const remainder = value.slice((match.index ?? 0) + match[0].length);
    const userInfoEnd = remainder.search(/(?<!\*\*\*:\*\*\*)@/u);
    const authorityEnd = remainder.search(/[\\/?#]/u);
    // After the authority, only path text shaped like spilled userinfo remains ambiguous.
    const pathBeforeAt = remainder.slice(authorityEnd + 1, userInfoEnd);
    if (
      userInfoEnd >= 0 &&
      (authorityEnd < 0 ||
        userInfoEnd <= authorityEnd ||
        (remainder[authorityEnd] === "/" &&
          (pathBeforeAt.includes(":") ||
            /^[^/?#\s]+\.[^/?#\s]+(?:[/?#]|$)/u.test(remainder.slice(userInfoEnd + 1)))))
    ) {
      return true;
    }
  }
  return false;
}

function redactRelativeUrlFragment(value: string, depth: number): string {
  const fragmentIndex = value.indexOf("#");
  if (fragmentIndex < 0) {
    return value;
  }
  const fragment = value.slice(fragmentIndex + 1);
  const redactedFragment = redactFragment(fragment, depth + 1);
  return redactedFragment === fragment
    ? value
    : `${value.slice(0, fragmentIndex + 1)}${redactedFragment}`;
}

function redactFragment(value: string, depth: number): string {
  if (!value) {
    return value;
  }
  if (depth > MAX_NESTED_URL_REDACTION_DEPTH && looksLikeNestedUrlValue(value)) {
    return "***";
  }

  const wholeUrl = redactSensitiveUrlAtDepth(value, depth);
  if (wholeUrl.parsedWholeUrl) {
    return redactUrlLikeFallback(wholeUrl.value);
  }

  const candidate = value;
  // Query-only fragments do not have a leading `?`, so the URL-like fallback cannot see them.
  const firstQueryDelimiter = candidate.search(/[?&]/u);
  const firstEquals = candidate.indexOf("=");
  if (firstEquals >= 0 && (firstQueryDelimiter < 0 || firstEquals < firstQueryDelimiter)) {
    return redactQueryString(candidate, depth);
  }

  const hashRouterQueryIndex = candidate.indexOf("?");
  if (hashRouterQueryIndex >= 0) {
    const query = candidate.slice(hashRouterQueryIndex + 1);
    const redactedQuery = redactQueryString(query, depth);
    const prefix = candidate.slice(0, hashRouterQueryIndex + 1);
    const redactedPrefix = redactEncodedUrlLikeString(redactUrlLikeFallback(prefix), depth + 1);
    return `${redactedPrefix}${redactedQuery}`;
  }

  const fallback = redactUrlLikeFallback(candidate);
  if (!looksLikeNestedUrlValue(fallback)) {
    return fallback;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(fallback);
  } catch {
    return "***";
  }
  if (decoded === fallback) {
    return fallback;
  }
  const redactedDecoded = redactFragment(decoded, depth + 1);
  return redactedDecoded === decoded ? fallback : encodeURIComponent(redactedDecoded);
}

function redactEncodedNestedUrlPath(value: string, depth: number): string {
  if (!looksLikeNestedUrlValue(value)) {
    return value;
  }
  if (depth > MAX_NESTED_URL_REDACTION_DEPTH) {
    return "***";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "***";
  }
  if (decoded === value) {
    return value;
  }

  const direct = redactSensitiveUrlLikeStringAtDepth(decoded, depth);
  // Emit sanitized decoded secrets; unresolved decoded authorities fail closed.
  if (direct.value !== decoded || hasUnresolvedEmbeddedUrlUserInfo(decoded)) {
    return direct.value !== decoded ? direct.value : "***";
  }
  if (direct.parsedWholeUrl) {
    return value;
  }

  const nested = redactEncodedNestedUrlPath(decoded, depth + 1);
  return nested === decoded ? value : nested;
}

function redactSensitiveUrlAtDepth(value: string, depth: number): UrlRedactionResult {
  try {
    const directRedaction = redactDirectSensitiveUrl(value);
    const parsed = new URL(directRedaction);
    if (depth > MAX_NESTED_URL_REDACTION_DEPTH) {
      return { value: "***", parsedWholeUrl: true };
    }
    let mutated = directRedaction !== value;
    const redactedNestedPath = redactEmbeddedUrlUserInfo(
      redactEncodedNestedUrlPath(parsed.pathname, depth + 1),
    );
    if (redactedNestedPath !== parsed.pathname) {
      const originalPath = parsed.pathname;
      parsed.pathname = redactedNestedPath;
      if (parsed.pathname === originalPath) {
        // Opaque/diagnostic schemes reject pathname assignment; use the whole-string scanner.
        return { value: directRedaction, parsedWholeUrl: false };
      }
      mutated = true;
    }
    const redactedQuery = redactQueryString(parsed.search.slice(1), depth);
    if (redactedQuery !== parsed.search.slice(1)) {
      parsed.search = redactedQuery;
      mutated = true;
    }

    const fragment = parsed.hash.slice(1);
    const redactedHash = redactFragment(fragment, depth + 1);
    if (redactedHash !== fragment) {
      parsed.hash = redactedHash;
      mutated = true;
    }
    return { value: mutated ? parsed.toString() : value, parsedWholeUrl: true };
  } catch {
    return { value, parsedWholeUrl: false };
  }
}

function redactSensitiveUrlLikeStringAtDepth(value: string, depth: number): UrlRedactionResult {
  const redactedUrl = redactSensitiveUrlAtDepth(value, depth);
  if (redactedUrl.parsedWholeUrl) {
    return redactedUrl;
  }
  const redactedFallback = redactUrlLikeFallback(redactedUrl.value);
  const redactedRelativeFragment = redactRelativeUrlFragment(redactedFallback, depth);
  return {
    value: redactEncodedUrlLikeString(redactedRelativeFragment, depth + 1),
    parsedWholeUrl: false,
  };
}

function redactEncodedUrlLikeString(value: string, depth: number): string {
  if (!looksLikeNestedUrlValue(value)) {
    return value;
  }
  if (depth > MAX_NESTED_URL_REDACTION_DEPTH) {
    return "***";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "***";
  }
  if (decoded === value) {
    return value;
  }

  const redactedDecoded = redactSensitiveUrlLikeStringAtDepth(decoded, depth + 1);
  if (redactedDecoded.value !== decoded || redactedDecoded.parsedWholeUrl) {
    return redactedDecoded.value === decoded ? value : redactedDecoded.value;
  }
  return hasUnresolvedEmbeddedUrlUserInfo(decoded) ? "***" : value;
}

function redactNestedUrlValue(value: string, depth: number): string {
  if (!looksLikeNestedUrlValue(value)) {
    return value;
  }
  if (depth > MAX_NESTED_URL_REDACTION_DEPTH) {
    return "***";
  }

  const direct = redactSensitiveUrlLikeStringAtDepth(value, depth);
  // A valid safe URL is terminal; decoding it again could reinterpret its encoded path or query.
  if (direct.value !== value) {
    return direct.value;
  }
  if (hasUnresolvedEmbeddedUrlUserInfo(value)) {
    return "***";
  }
  if (direct.parsedWholeUrl) {
    return value;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "***";
  }
  if (decoded === value || !looksLikeNestedUrlValue(decoded)) {
    return value;
  }

  const redactedDecoded = redactNestedUrlValue(decoded, depth + 1);
  return redactedDecoded === decoded ? value : encodeURIComponent(redactedDecoded);
}

/** Redacts credentials and sensitive query params from URL values. */
export function redactSensitiveUrl(value: string): string {
  return redactSensitiveUrlLikeStringAtDepth(value, 0).value;
}

/** Redacts sensitive URL-looking substrings even when the full value is not a valid URL. */
export function redactSensitiveUrlLikeString(value: string): string {
  return redactSensitiveUrlLikeStringAtDepth(value, 0).value;
}
