import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import { expectDefined } from "@openclaw/normalization-core";
// Redaction helpers scrub secrets and sensitive identifiers from log output.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  findStructuredAuthParamRanges,
  redactStructuredAuthHeaders,
} from "../../packages/acp-core/src/structured-auth-redaction.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { replacePatternBounded } from "./redact-bounded.js";
import { isFullContextToolPayloadRedaction } from "./redact-internal.js";
import {
  AWS_SECRET_ACCESS_KEY_FIELD_KEYS,
  AWS_SECRET_ACCESS_KEY_VALUE_PATTERN,
  BASE64_SAFE_TOKEN_BOUNDARY,
  BODY_SECRET_KEYS,
  CHUNK_UNSAFE_PATTERN_SOURCES,
  DEFAULT_REDACT_PATTERNS,
  FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES,
  FORM_BODY_KEY_INVISIBLE_CHARS,
  IDENTIFIER_SAFE_TOKEN_BOUNDARY,
  PAYMENT_CREDENTIAL_ENV_KEYS,
  PAYMENT_CREDENTIAL_JSON_KEYS,
  PAYMENT_CREDENTIAL_QUERY_KEYS,
  SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES,
  TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS,
  TOOL_PAYLOAD_REDACT_PATTERNS,
} from "./redact-patterns.js";
import { redactRegisteredSecretValues } from "./secret-redaction-registry.js";

type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;
type LoggingConfig = OpenClawConfig["logging"];

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const shellReferencePreservingPatterns = new WeakSet<RegExp>();
// Patterns whose left-context assertions or complete token can cross a chunk boundary must run
// against the full string; chunking can invent a `^` boundary or split the secret itself.
const chunkUnsafePatterns = new WeakSet<RegExp>();
const formAwareEqualsAssignmentPatterns = new WeakSet<RegExp>();
const sourceAssignmentPatterns = new WeakSet<RegExp>();
let defaultResolvedPatterns: RegExp[] | undefined;
let toolPayloadResolvedPatterns: RegExp[] | undefined;

const FORM_BODY_KEY_OBFUSCATION_RE = new RegExp(
  String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]`,
  "gu",
);
const FORM_BODY_KEY_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;
const FORM_BODY_PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/u;
const FORM_BODY_KEY = String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*(?:[A-Za-z_]|%[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.-]|%[0-9A-Fa-f]{2}|[${FORM_BODY_KEY_INVISIBLE_CHARS}+])*`;
const FORM_BODY_VALUE = "[^&\\s<>]*";
const URL_QUERY_VALUE = "[^&#\\s<>]*";
const FORM_BODY_PAIR = String.raw`${FORM_BODY_KEY}=${FORM_BODY_VALUE}`;
const FORM_BODY_RE = new RegExp(String.raw`^${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+$`, "u");
const FORM_BODY_SUBSTRING_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`])(${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+)`,
  "gu",
);
const ENCODED_FORM_PAIR_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`&])(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})`,
  "gu",
);
const FORM_BODY_CONTEXT_SINGLE_PAIR_RE = new RegExp(
  String.raw`(\b(?:body|form(?:[-_\s]?body)?)\s*[:=]\s*(["'\x60]?))(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})(["'\x60]?)`,
  "giu",
);
const URL_QUERY_PAIR_RE = new RegExp(
  String.raw`([?&])(${FORM_BODY_KEY})=(${URL_QUERY_VALUE})`,
  "gu",
);
const SECRET_VALUE_TRAILING_DELIMITER_RE = /(["'`,;)}\]]+)$/u;
const SECRET_VALUE_SUFFIX_RE = /^["'`,;)}\]]*$/u;
const SECRET_VALUE_QUOTE_CHARS = new Set(['"', "'", "`"]);
const FORM_BODY_LINE_BREAK_SPLIT_RE = /(\r\n|\r|\n)/u;
const FORM_BODY_LINE_BREAK_SEGMENT_RE = /^(?:\r\n|\r|\n)$/u;
const STRUCTURED_SECRET_FIELD_RE = new RegExp(
  String.raw`^(?:api[-_]?key|apiKey|api[-_]?token|apiToken|bearer[-_]?token|bearerToken|token|secret|password|passwd|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|private[-_]?key|privateKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|secret[-_]?value|secretValue|raw[-_]?secret|rawSecret|secret[-_]?input|secretInput|key|key[-_]?material|keyMaterial|jwt|session|signature|cookie|set[-_]?cookie|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`,
  "i",
);
const STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE = /^\$WORKSPACE_DIR\/[A-Za-z0-9._/-]+\.jsonl$/u;
const STRUCTURED_APP_PASSWORD_FIELD_RE =
  /^(?:apple|icloud|app[-_]?specific[-_]?password|appSpecificPassword|application[-_]?password|text|content|message|error|errorMessage|detail|details|reason)$/i;
const APP_SPECIFIC_PASSWORD_RE = /\b([a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4})\b/g;
const BENIGN_APP_PASSWORD_WORDS = new Set([
  "case",
  "claw",
  "demo",
  "file",
  "main",
  "name",
  "open",
  "path",
  "slug",
  "test",
]);
const STRUCTURED_SECRET_ENV_FIELD_RE = new RegExp(
  String.raw`^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})$`,
  "i",
);

// Fast-path gate: with no user-configured patterns, redactSensitiveText skips the full
// default-pattern walk unless one of these triggers matches. Every DEFAULT_REDACT_PATTERNS
// entry and sensitive form/URL key must stay reachable here — a missing trigger silently
// leaks that secret shape, so each family keeps a default-options fixture in redact.test.ts.
const DEFAULT_REDACT_PREFILTER_SOURCES: string[] = [
  // Sensitive key names shared by the env/JSON/query/form/header/assignment families.
  String.raw`KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SIGNATURE|CREDENTIAL|CARD|CVC|CVV|PAYMENT|PRIVATE KEY`,
  String.raw`security[-_]?code|\bpass\s*[=:]|\bpassphrase\s*[=:]|_(?:password|pass|passphrase|passwd)\s*[=:]|jwt\s*[=:]|session=|code=|\bsig\s*=`,
  String.raw`\bBearer\s+`,
  // URL userinfo and connection-string password slots (`scheme://user:pass@host`).
  String.raw`:\/\/[^\/\s:@]*:[^\/\s@]+@`,
  // Vendor token prefixes and webhook hosts, ordered like DEFAULT_REDACT_PATTERNS.
  String.raw`sk-|gh[opsur]_|github_pat_|glpat-|gloas-|gldt-|glcbt-|glptt-|glft-|glimt-|glagent-|glwt-|glsoat-|glffct-|glrt-|glrtr-|GR1348941|_gitlab_session=|xox[baprs]-|xapp-|hooks\.slack\.com|discord|gsk_|AIza|ya29\.|1\/\/0|eyJ|pplx-|fal_|fc-|bb_live_|gAAAA|[sr]k_(?:live|test)_|\bSG\.|npm_|pypi-|do[opr]_v1_|dp\.(?:ct|pt|sa|st|scim|audit)\.|dckr_|bkua_|CCIPAT_|sbp_|dapi[0-9a-f]|dd[pw]_|glsa_|nfp_|CFPAT-|ATCTT3|ATATT|ATBB|BBDC-|HRKU-|pat-(?:eu|na)1-|apify_api_|FlyV1|fio-u-|tvly-|exa_|syt_|retaindb_|mem0_|brv_|xai-|fw-|fw_|fpk_`,
  String.raw`(?:^|[^A-Za-z0-9_])(?:am_|sk_)`,
  String.raw`A[KS]IA[A-Z0-9]|AKID|LTAI|hf_|api_org_|r8_`,
  AWS_SECRET_ACCESS_KEY_VALUE_PATTERN,
  String.raw`\bbot\d{6,}:|\b\d{6,}:[A-Za-z0-9_-]{20,}`,
  // Obfuscated form/URL keys: percent escapes can rewrite any key letter, while plus or
  // invisible splices break the literal key-name triggers above mid-word. After a splice the
  // tail may mix further splices with key characters (e.g. an interior plus a trailing
  // filler), but at least one key character must follow a splice so bare `+=` or line-leading
  // `===` separators do not trip the fast path.
  String.raw`%[0-9A-Fa-f]{2}[A-Za-z0-9_%.-]*=`,
  String.raw`(?:\+|[${FORM_BODY_KEY_INVISIBLE_CHARS}])(?:[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*[A-Za-z0-9_%.-])+[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*=`,
];
const DEFAULT_REDACT_PREFILTER_RE = new RegExp(
  `(?:${DEFAULT_REDACT_PREFILTER_SOURCES.join("|")})`,
  "iu",
);

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: readonly RedactPattern[];
  sensitiveFieldPatterns?: readonly RedactPattern[];
};

type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: RegExp[];
  redactFormBodies: boolean;
  redactStructuredAuthHeaders?: boolean;
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: RedactPattern): RegExp | null {
  let pattern: RegExp | null = null;
  if (raw instanceof RegExp) {
    if (raw.flags.includes("g")) {
      pattern = raw;
    } else {
      pattern = new RegExp(raw.source, `${raw.flags}g`);
    }
  } else if (raw.trim()) {
    const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      const flags = expectDefined(match[2], "redact regex capture 2").includes("g")
        ? match[2]
        : `${match[2]}g`;
      pattern =
        compileConfigRegex(expectDefined(match[1], "redact regex capture 1"), flags)?.regex ?? null;
    } else {
      pattern = compileConfigRegex(raw, "gi")?.regex ?? null;
    }
  }
  if (pattern && typeof raw === "string" && SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES.has(raw)) {
    shellReferencePreservingPatterns.add(pattern);
  }
  if (pattern && typeof raw === "string" && TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS.has(raw)) {
    sourceAssignmentPatterns.add(pattern);
  }
  if (pattern && typeof raw === "string" && FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES.has(raw)) {
    formAwareEqualsAssignmentPatterns.add(pattern);
  }
  if (
    pattern &&
    typeof raw === "string" &&
    (raw.startsWith(BASE64_SAFE_TOKEN_BOUNDARY) ||
      raw.startsWith(IDENTIFIER_SAFE_TOKEN_BOUNDARY) ||
      CHUNK_UNSAFE_PATTERN_SOURCES.has(raw))
  ) {
    chunkUnsafePatterns.add(pattern);
  }
  return pattern;
}

function resolvePatterns(value?: readonly RedactPattern[]): RegExp[] {
  if (value === TOOL_PAYLOAD_REDACT_PATTERNS) {
    toolPayloadResolvedPatterns ??= TOOL_PAYLOAD_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is RegExp => Boolean(re),
    );
    return toolPayloadResolvedPatterns;
  }
  if (!value?.length || value === DEFAULT_REDACT_PATTERNS) {
    defaultResolvedPatterns ??= DEFAULT_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is RegExp => Boolean(re),
    );
    return defaultResolvedPatterns;
  }
  return value.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function includesDefaultRedactPatterns(value?: readonly RedactPattern[]): boolean {
  if (!value || usesBuiltInRedactPatterns(value)) {
    return true;
  }
  const source = new Set(value.filter((pattern): pattern is string => typeof pattern === "string"));
  return (
    DEFAULT_REDACT_PATTERNS.every((pattern) => source.has(pattern)) ||
    TOOL_PAYLOAD_REDACT_PATTERNS.every((pattern) => source.has(pattern))
  );
}

function usesBuiltInRedactPatterns(value?: readonly RedactPattern[]): boolean {
  return (
    !value?.length || value === DEFAULT_REDACT_PATTERNS || value === TOOL_PAYLOAD_REDACT_PATTERNS
  );
}

function maskToken(token: string): string {
  if (token === "***") {
    return token;
  }
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = sliceUtf16Safe(token, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(token, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function splitSecretValueForMask(token: string): {
  maskable: string;
  suffix: string;
  maskStart: number;
  maskEnd: number;
} {
  const openingQuote = token[0] ?? "";
  if (SECRET_VALUE_QUOTE_CHARS.has(openingQuote)) {
    const closingQuoteIndex = token.lastIndexOf(openingQuote);
    if (closingQuoteIndex > 0) {
      const suffix = token.slice(closingQuoteIndex + 1);
      if (SECRET_VALUE_SUFFIX_RE.test(suffix)) {
        return {
          maskable: token.slice(1, closingQuoteIndex),
          suffix,
          maskStart: 0,
          maskEnd: closingQuoteIndex + 1,
        };
      }
    }

    const tokenWithoutLeadingQuote = token.slice(1);
    const trailingDelimiter =
      tokenWithoutLeadingQuote.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
    const maskable =
      trailingDelimiter && trailingDelimiter.length < tokenWithoutLeadingQuote.length
        ? tokenWithoutLeadingQuote.slice(0, -trailingDelimiter.length)
        : tokenWithoutLeadingQuote;
    return {
      maskable,
      suffix:
        trailingDelimiter && trailingDelimiter.length < tokenWithoutLeadingQuote.length
          ? trailingDelimiter
          : "",
      maskStart: 0,
      maskEnd: 1 + maskable.length,
    };
  }

  const trailingDelimiter = token.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
  const maskable =
    trailingDelimiter && trailingDelimiter.length < token.length
      ? token.slice(0, -trailingDelimiter.length)
      : token;
  return {
    maskable,
    suffix: maskable === token ? "" : trailingDelimiter,
    maskStart: 0,
    maskEnd: maskable.length,
  };
}

function splitFormAwareCredentialValue(token: string): { secret: string; suffix: string } {
  const pairBoundary = token.search(/&[A-Za-z_][A-Za-z0-9_.-]*=/u);
  return pairBoundary < 0
    ? { secret: token, suffix: "" }
    : { secret: token.slice(0, pairBoundary), suffix: token.slice(pairBoundary) };
}

function maskSecretValue(token: string, options?: { hinted?: boolean }): string {
  const { maskable, suffix } = splitSecretValueForMask(token);
  return `${options?.hinted ? maskToken(maskable) : "***"}${suffix}`;
}

function normalizeSensitiveKeyName(value: string): string {
  const stripped = value.replace(FORM_BODY_KEY_SEPARATOR_RE, "");
  try {
    return decodeURIComponent(stripped)
      .replace(FORM_BODY_KEY_SEPARATOR_RE, "")
      .toLowerCase()
      .replaceAll("-", "_");
  } catch {
    return stripped.toLowerCase().replaceAll("-", "_");
  }
}

function isSensitiveBodyKey(key: string): boolean {
  return isSensitiveUrlQueryParamName(key) || BODY_SECRET_KEYS.has(normalizeSensitiveKeyName(key));
}

function hasEncodedOrInvisibleFormKey(key: string): boolean {
  return (
    FORM_BODY_PERCENT_ESCAPE_RE.test(key) || key.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") !== key
  );
}

function redactFormEncodedPairs(
  value: string,
  options?: { maskValues?: "fixed" | "hinted"; onlyEncodedOrInvisibleKeys?: boolean },
): string {
  return value
    .split("&")
    .map((pair) => {
      const equalsIndex = pair.indexOf("=");
      if (equalsIndex < 0) {
        return pair;
      }
      const key = pair.slice(0, equalsIndex);
      if (options?.onlyEncodedOrInvisibleKeys && !hasEncodedOrInvisibleFormKey(key)) {
        return pair;
      }
      if (!isSensitiveBodyKey(key)) {
        return pair;
      }
      const token = pair.slice(equalsIndex + 1);
      const masked = maskSecretValue(token, { hinted: options?.maskValues === "hinted" });
      return `${key}=${masked}`;
    })
    .join("&");
}

function markBitmapRange(bitmap: boolean[], start: number, end: number): void {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(bitmap.length, end);
  for (let i = boundedStart; i < boundedEnd; i++) {
    bitmap[i] = true;
  }
}

function markSensitiveFormEncodedPairValues(
  bitmap: boolean[],
  value: string,
  offset: number,
  options?: { onlyEncodedOrInvisibleKeys?: boolean },
): void {
  let cursor = 0;
  for (const pair of value.split("&")) {
    const pairStart = cursor;
    const pairEnd = pairStart + pair.length;
    cursor = pairEnd + 1;

    const equalsIndex = pair.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const key = pair.slice(0, equalsIndex);
    if (options?.onlyEncodedOrInvisibleKeys && !hasEncodedOrInvisibleFormKey(key)) {
      continue;
    }
    if (!isSensitiveBodyKey(key)) {
      continue;
    }

    const token = pair.slice(equalsIndex + 1);
    const secretValue = splitSecretValueForMask(token);
    const valueStart = pairStart + equalsIndex + 1 + secretValue.maskStart;
    const valueEnd = pairStart + equalsIndex + 1 + secretValue.maskEnd;
    markBitmapRange(bitmap, offset + valueStart, offset + valueEnd);
  }
}

function redactUrlQueryPairs(text: string): string {
  if (!text || !text.includes("?")) {
    return text;
  }
  return text.replace(URL_QUERY_PAIR_RE, (match, prefix: string, key: string, token: string) => {
    if (!isSensitiveBodyKey(key)) {
      return match;
    }
    return `${prefix}${key}=${maskSecretValue(token, { hinted: true })}`;
  });
}

function markUrlQueryPairRedactions(text: string, bitmap: boolean[]): void {
  if (!text || !text.includes("?")) {
    return;
  }
  for (const match of text.matchAll(URL_QUERY_PAIR_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const prefix = match[1] ?? "";
    const key = match[2] ?? "";
    const token = match[3] ?? "";
    if (!isSensitiveBodyKey(key)) {
      continue;
    }
    const secretValue = splitSecretValueForMask(token);
    const valueOffset = match.index + prefix.length + key.length + 1;
    markBitmapRange(bitmap, valueOffset + secretValue.maskStart, valueOffset + secretValue.maskEnd);
  }
}

function redactEncodedFormPairs(text: string): string {
  if (!text || (!text.includes("%") && text.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") === text)) {
    return text;
  }
  return text.replace(ENCODED_FORM_PAIR_RE, (match, prefix: string, key: string, token: string) => {
    if (!hasEncodedOrInvisibleFormKey(key) || !isSensitiveBodyKey(key)) {
      return match;
    }
    return `${prefix}${key}=${maskSecretValue(token)}`;
  });
}

function markEncodedFormPairRedactions(text: string, bitmap: boolean[], offset = 0): void {
  if (!text || (!text.includes("%") && text.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") === text)) {
    return;
  }
  for (const match of text.matchAll(ENCODED_FORM_PAIR_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const prefix = match[1] ?? "";
    const key = match[2] ?? "";
    const token = match[3] ?? "";
    if (!hasEncodedOrInvisibleFormKey(key) || !isSensitiveBodyKey(key)) {
      continue;
    }
    const secretValue = splitSecretValueForMask(token);
    const valueOffset = match.index + prefix.length + key.length + 1;
    markBitmapRange(
      bitmap,
      offset + valueOffset + secretValue.maskStart,
      offset + valueOffset + secretValue.maskEnd,
    );
  }
}

function redactFormBodyContextSinglePairs(text: string): string {
  if (!text || !/[=:]/u.test(text)) {
    return text;
  }
  return text.replace(
    FORM_BODY_CONTEXT_SINGLE_PAIR_RE,
    (match, prefix: string, _quote: string, key: string, token: string, suffix: string) => {
      if (!isSensitiveBodyKey(key)) {
        return match;
      }
      return `${prefix}${key}=${maskSecretValue(token)}${suffix}`;
    },
  );
}

function markFormBodyContextSinglePairRedactions(
  text: string,
  bitmap: boolean[],
  offset = 0,
): void {
  if (!text || !/[=:]/u.test(text)) {
    return;
  }
  for (const match of text.matchAll(FORM_BODY_CONTEXT_SINGLE_PAIR_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const prefix = match[1] ?? "";
    const key = match[3] ?? "";
    const token = match[4] ?? "";
    if (!isSensitiveBodyKey(key)) {
      continue;
    }
    const secretValue = splitSecretValueForMask(token);
    const valueOffset = match.index + prefix.length + key.length + 1;
    markBitmapRange(
      bitmap,
      offset + valueOffset + secretValue.maskStart,
      offset + valueOffset + secretValue.maskEnd,
    );
  }
}

function redactFormBodyLine(text: string): string {
  if (!text) {
    return text;
  }
  const contextRedacted = redactFormBodyContextSinglePairs(redactEncodedFormPairs(text));
  if (!contextRedacted.includes("&")) {
    return contextRedacted;
  }
  if (FORM_BODY_RE.test(contextRedacted)) {
    return redactFormEncodedPairs(contextRedacted);
  }
  const redacted = contextRedacted.replace(
    FORM_BODY_SUBSTRING_RE,
    (match, prefix: string, body: string) => {
      const redactedBody = redactFormEncodedPairs(body);
      return redactedBody === body ? match : `${prefix}${redactedBody}`;
    },
  );
  return redactFormBodyContextSinglePairs(redactEncodedFormPairs(redacted));
}

function redactFormBody(text: string): string {
  if (!text) {
    return text;
  }
  if (FORM_BODY_LINE_BREAK_SPLIT_RE.test(text)) {
    return text
      .split(FORM_BODY_LINE_BREAK_SPLIT_RE)
      .map((segment) =>
        FORM_BODY_LINE_BREAK_SEGMENT_RE.test(segment) ? segment : redactFormBodyLine(segment),
      )
      .join("");
  }
  return redactFormBodyLine(text);
}

function markFormBodyLineRedactions(text: string, bitmap: boolean[], offset: number): void {
  if (!text) {
    return;
  }
  markEncodedFormPairRedactions(text, bitmap, offset);
  markFormBodyContextSinglePairRedactions(text, bitmap, offset);
  if (!text.includes("&")) {
    return;
  }
  if (FORM_BODY_RE.test(text)) {
    markSensitiveFormEncodedPairValues(bitmap, text, offset);
    return;
  }
  for (const match of text.matchAll(FORM_BODY_SUBSTRING_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const prefix = match[1] ?? "";
    const body = match[2] ?? "";
    markSensitiveFormEncodedPairValues(bitmap, body, offset + match.index + prefix.length);
  }
}

function markFormBodyRedactions(text: string, bitmap: boolean[]): void {
  if (!text) {
    return;
  }
  if (!FORM_BODY_LINE_BREAK_SPLIT_RE.test(text)) {
    markFormBodyLineRedactions(text, bitmap, 0);
    return;
  }
  let offset = 0;
  for (const segment of text.split(FORM_BODY_LINE_BREAK_SPLIT_RE)) {
    if (!FORM_BODY_LINE_BREAK_SEGMENT_RE.test(segment)) {
      markFormBodyLineRedactions(segment, bitmap, offset);
    }
    offset += segment.length;
  }
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function isShellReferenceToKey(key: string, value: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  const bare = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (bare) {
    return bare[1] === key;
  }
  const braced = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(?::[-=?+])?\}$/);
  return braced?.[1] === key;
}

function readEnvAssignmentKey(match: string): string | undefined {
  return match.match(/\b([A-Z_][A-Z0-9_]*)\b\s*[=:]/)?.[1];
}

function shouldPreserveShellReferenceMatch(match: string, token: string): boolean {
  const key = readEnvAssignmentKey(match);
  return key ? isShellReferenceToKey(key, token) : false;
}

function isEmptyShellParameterExpansionTail(token: string): boolean {
  return /^[-=?+]\}$/.test(token);
}

function hasBackreferenceToGroup(pattern: RegExp, groupNumber: number): boolean {
  return new RegExp(String.raw`\\${groupNumber}(?!\d)`).test(pattern.source);
}

type SecretCaptureSelection = {
  captureCount: number;
  index: number;
  value: string;
};

function selectSecretCapture(match: string, groups: string[]): SecretCaptureSelection {
  const tokens = groups
    .map((value, index) => ({ index, value }))
    .filter(({ value }) => typeof value === "string" && value.length > 0);
  const selected = (tokens.length > 1 ? tokens[tokens.length - 1] : tokens[0]) ?? {
    index: -1,
    value: match,
  };
  return {
    ...selected,
    captureCount: tokens.length,
  };
}

function getIndexedCaptureStart(
  pattern: RegExp,
  input: string,
  match: string,
  matchOffset: number,
  captureIndex: number,
): number | null {
  if (matchOffset < 0 || !input) {
    return null;
  }
  try {
    const flags = pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`;
    const indexedPattern = new RegExp(pattern.source, flags);
    indexedPattern.lastIndex = matchOffset;
    const indexedMatch = indexedPattern.exec(input) as
      | (RegExpExecArray & { indices?: Array<[number, number] | undefined> })
      | null;
    const captureIndices = indexedMatch?.indices?.[captureIndex + 1];
    if (!indexedMatch || indexedMatch.index !== matchOffset || indexedMatch[0] !== match) {
      return null;
    }
    if (!captureIndices) {
      return null;
    }
    return captureIndices[0] - matchOffset;
  } catch {
    return null;
  }
}

function getSecretCaptureStart(
  pattern: RegExp,
  input: string,
  match: string,
  matchOffset: number,
  selected: SecretCaptureSelection,
): number {
  const indexedTokenStart = getIndexedCaptureStart(
    pattern,
    input,
    match,
    matchOffset,
    selected.index,
  );
  const preferFirstCapture =
    selected.captureCount === 1 &&
    selected.index >= 0 &&
    hasBackreferenceToGroup(pattern, selected.index + 1);
  return (
    indexedTokenStart ??
    (preferFirstCapture ? match.indexOf(selected.value) : match.lastIndexOf(selected.value))
  );
}

function redactMatch(
  match: string,
  groups: string[],
  pattern: RegExp,
  context?: {
    input?: string;
    offset?: number;
    preserveSourceAssignment?: (text: string, offset: number) => boolean;
  },
): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const selected = selectSecretCapture(match, groups);
  const token = selected.value;
  if (
    sourceAssignmentPatterns.has(pattern) &&
    context?.preserveSourceAssignment?.(
      context.input ?? "",
      (context.offset ?? -1) +
        getSecretCaptureStart(pattern, context.input ?? "", match, context.offset ?? -1, selected),
    )
  ) {
    return match;
  }
  const formAwareValue = formAwareEqualsAssignmentPatterns.has(pattern)
    ? splitFormAwareCredentialValue(token)
    : { secret: token, suffix: "" };
  // An earlier pass (form-body or quoted-assignment masking) may already have replaced this
  // value with ***; re-masking would strip its quote wrapper around the placeholder.
  if (splitSecretValueForMask(formAwareValue.secret).maskable === "***") {
    return match;
  }
  const isShellReferencePattern = shellReferencePreservingPatterns.has(pattern);
  // Preserve shell variable references (e.g. `MY_TOKEN=$MY_TOKEN`) for assignment patterns
  // registered as shell-reference-preserving, so non-secret expansions that merely echo the
  // assignment key are not masked.
  if (
    isShellReferencePattern &&
    (shouldPreserveShellReferenceMatch(match, token) || isEmptyShellParameterExpansionTail(token))
  ) {
    return match;
  }
  // Assignment values can legitimately include trailing shell/structural characters
  // (e.g. `${VAR:-default}`); mask the captured token whole so those characters count toward the
  // retained hint instead of being exposed by delimiter-aware masking.
  // Source goes through both the guard and SQLite. Full assignment masks keep
  // those copies identical; diagnostic hints otherwise shrink on the second pass.
  const masked =
    context?.preserveSourceAssignment && sourceAssignmentPatterns.has(pattern)
      ? maskSecretValue(token)
      : isShellReferencePattern
        ? maskToken(token)
        : `${maskSecretValue(formAwareValue.secret, { hinted: true })}${formAwareValue.suffix}`;
  if (token === match) {
    return masked;
  }
  const tokenIndex = getSecretCaptureStart(
    pattern,
    context?.input ?? "",
    match,
    context?.offset ?? -1,
    selected,
  );
  if (tokenIndex < 0) {
    return match;
  }
  return `${match.slice(0, tokenIndex)}${masked}${match.slice(tokenIndex + token.length)}`;
}

function redactText(
  text: string,
  patterns: RegExp[],
  options?: {
    fullContext?: boolean;
    redactFormBodies?: boolean;
    redactStructuredAuthHeaders?: boolean;
    preserveSourceAssignment?: (text: string, offset: number) => boolean;
  },
): string {
  let next = text;
  if (options?.redactStructuredAuthHeaders) {
    next = redactStructuredAuthHeaders(next, "***");
  }
  if (options?.redactFormBodies) {
    next = redactUrlQueryPairs(next);
    next = redactFormBody(next);
  }
  for (const pattern of patterns) {
    const replacer = (...args: unknown[]) => {
      const hasNamedGroups =
        args.length > 0 &&
        typeof args[args.length - 1] === "object" &&
        args[args.length - 1] !== null;
      const inputIndex = hasNamedGroups ? args.length - 2 : args.length - 1;
      const offsetIndex = inputIndex - 1;
      const match = typeof args[0] === "string" ? args[0] : "";
      const groups = args
        .slice(1, offsetIndex)
        .map((value) => (typeof value === "string" ? value : ""));
      const offset = typeof args[offsetIndex] === "number" ? args[offsetIndex] : -1;
      const input = typeof args[inputIndex] === "string" ? args[inputIndex] : "";
      return redactMatch(match, groups, pattern, {
        input,
        offset,
        preserveSourceAssignment: options?.preserveSourceAssignment,
      });
    };
    next =
      options?.fullContext || chunkUnsafePatterns.has(pattern)
        ? next.replace(pattern, replacer)
        : replacePatternBounded(next, pattern, replacer);
  }
  return next;
}

function couldMatchDefaultRedactPatterns(text: string): boolean {
  return DEFAULT_REDACT_PREFILTER_RE.test(text);
}

function cloneGlobalPattern(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

function markPatternMatchRedaction(
  bitmap: boolean[],
  input: string,
  pattern: RegExp,
  match: RegExpMatchArray,
): void {
  if (match.index === undefined) {
    return;
  }
  const fullMatch = match[0] ?? "";
  if (fullMatch.includes("PRIVATE KEY-----")) {
    markBitmapRange(bitmap, match.index, match.index + fullMatch.length);
    return;
  }
  const selected = selectSecretCapture(
    fullMatch,
    match.slice(1).map((value) => (typeof value === "string" ? value : "")),
  );
  const tokenStart =
    selected.value === fullMatch
      ? 0
      : getSecretCaptureStart(pattern, input, fullMatch, match.index, selected);
  if (tokenStart < 0) {
    return;
  }
  const selectedSecret = formAwareEqualsAssignmentPatterns.has(pattern)
    ? splitFormAwareCredentialValue(selected.value).secret
    : selected.value;
  const secretValue = splitSecretValueForMask(selectedSecret);
  markBitmapRange(
    bitmap,
    match.index + tokenStart + secretValue.maskStart,
    match.index + tokenStart + secretValue.maskEnd,
  );
}

export function computeSensitiveRedactionBitmap(
  text: string,
  resolved: ResolvedRedactOptions,
): boolean[] {
  // oxlint-disable-next-line unicorn/no-new-array -- Fill the dense bitmap without a callback for every character.
  const bitmap = new Array<boolean>(text.length).fill(false);
  if (resolved.mode === "off" || !resolved.patterns.length || !text) {
    return bitmap;
  }
  if (resolved.redactStructuredAuthHeaders) {
    for (const range of findStructuredAuthParamRanges(text)) {
      markBitmapRange(bitmap, range.start, range.end);
    }
  }
  if (resolved.redactFormBodies) {
    markUrlQueryPairRedactions(text, bitmap);
    markFormBodyRedactions(text, bitmap);
  }
  for (const pattern of resolved.patterns) {
    for (const match of text.matchAll(cloneGlobalPattern(pattern))) {
      markPatternMatchRedaction(bitmap, text, pattern, match);
    }
  }
  return bitmap;
}

function looksLikeAppSpecificPassword(candidate: string): boolean {
  return candidate.split("-").every((part) => !BENIGN_APP_PASSWORD_WORDS.has(part.toLowerCase()));
}

function redactAppSpecificPasswords(text: string): string {
  return replacePatternBounded(text, APP_SPECIFIC_PASSWORD_RE, (match: string, token: string) =>
    looksLikeAppSpecificPassword(token)
      ? redactMatch(match, [token], APP_SPECIFIC_PASSWORD_RE)
      : match,
  );
}

function resolveConfigRedaction(): RedactOptions {
  const cfg = readLoggingConfig();
  return {
    mode: DEFAULT_REDACT_MODE,
    patterns: cfg?.redactPatterns,
  };
}

export function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions {
  const resolved = options ?? resolveConfigRedaction();
  const mode = normalizeMode(resolved.mode);
  if (mode === "off") {
    return {
      mode,
      patterns: [],
      redactFormBodies: false,
    };
  }
  const patterns = resolvePatterns(resolved.patterns);
  const includesDefaults = patterns.length > 0 && includesDefaultRedactPatterns(resolved.patterns);
  return {
    mode,
    patterns,
    redactFormBodies: includesDefaults,
    redactStructuredAuthHeaders: includesDefaults,
  };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const exactRedacted = redactRegisteredSecretValues(text, maskToken);
  const resolvedOptions = options ?? resolveConfigRedaction();
  if (normalizeMode(resolvedOptions.mode) === "off") {
    return exactRedacted;
  }
  if (
    usesBuiltInRedactPatterns(resolvedOptions.patterns) &&
    !couldMatchDefaultRedactPatterns(exactRedacted)
  ) {
    return exactRedacted;
  }
  const resolved = resolveRedactOptions(resolvedOptions);
  if (!resolved.patterns.length) {
    return exactRedacted;
  }
  return redactText(exactRedacted, resolved.patterns, {
    redactFormBodies: resolved.redactFormBodies,
    redactStructuredAuthHeaders: resolved.redactStructuredAuthHeaders,
  });
}

export function redactToolDetail(detail: string): string {
  return redactToolPayloadText(detail);
}

function resolveToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const patterns =
    userPatterns && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : undefined;
  return { mode: "tools", patterns };
}

function resolveModelVisibleToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const hasUserPatterns = userPatterns && userPatterns.length > 0;
  return {
    mode: "tools",
    patterns: hasUserPatterns
      ? [...userPatterns, ...TOOL_PAYLOAD_REDACT_PATTERNS]
      : TOOL_PAYLOAD_REDACT_PATTERNS,
    sensitiveFieldPatterns: hasUserPatterns
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : DEFAULT_REDACT_PATTERNS,
  };
}

// Forces tools-mode so UI/tool payloads never inherit a caller-supplied "off"
// mode, and merges user `logging.redactPatterns` with the built-in defaults so
// both apply.
export function redactToolPayloadText(text: string): string {
  return redactToolPayloadTextWithConfig(text, readLoggingConfig());
}

function redactToolPayloadTextWithPolicy(
  text: string,
  loggingConfig: LoggingConfig | undefined,
  options: RedactOptions,
): string {
  if (!text) {
    return text;
  }
  if (!isFullContextToolPayloadRedaction(loggingConfig)) {
    return redactSensitiveText(text, options);
  }
  const resolved = resolveRedactOptions(options);
  return redactText(redactRegisteredSecretValues(text, maskToken), resolved.patterns, {
    fullContext: true,
    redactFormBodies: resolved.redactFormBodies,
    redactStructuredAuthHeaders: resolved.redactStructuredAuthHeaders,
  });
}

export function redactToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactToolPayloadTextWithPolicy(
    text,
    loggingConfig,
    resolveToolPayloadRedaction(loggingConfig),
  );
}

/** Input source retains computations, but uses diagnostic credential masking, not output policy. */
export function redactInputTextWithSourcePolicy(
  text: string,
  loggingConfig: LoggingConfig | undefined,
  preserveSourceAssignment: (text: string, offset: number) => boolean,
): string {
  // Custom patterns run without syntax exemptions, even when identical to a built-in pattern.
  const customPatterns = loggingConfig?.redactPatterns;
  const prepared = customPatterns?.length
    ? redactSensitiveText(text, { mode: "tools", patterns: customPatterns })
    : redactRegisteredSecretValues(text, maskToken);
  return redactText(prepared, resolvePatterns(), {
    fullContext: true,
    redactFormBodies: true,
    redactStructuredAuthHeaders: true,
    preserveSourceAssignment,
  });
}

// Model-visible tool output commonly contains source code, so its assignment matching is
// intentionally narrower than diagnostic and logging redaction.
export function redactModelVisibleToolPayloadText(text: string): string {
  return redactModelVisibleToolPayloadTextWithConfig(text, readLoggingConfig());
}

export function redactModelVisibleToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactToolPayloadTextWithPolicy(
    text,
    loggingConfig,
    resolveModelVisibleToolPayloadRedaction(loggingConfig),
  );
}

export function isSensitiveFieldKey(key: string): boolean {
  return STRUCTURED_SECRET_FIELD_RE.test(key) || STRUCTURED_SECRET_ENV_FIELD_RE.test(key);
}

function redactSensitiveFieldValueWithOptions(
  key: string,
  value: string,
  options: RedactOptions,
  path: readonly string[] = [key],
): string {
  const exactRedacted = redactRegisteredSecretValues(value, maskToken);
  const sensitiveKey = isSensitiveFieldKey(key);
  const fieldOptions =
    sensitiveKey && options.sensitiveFieldPatterns
      ? { ...options, patterns: options.sensitiveFieldPatterns }
      : options;
  const resolved = resolveRedactOptions(fieldOptions);
  if (resolved.mode === "off") {
    return exactRedacted;
  }
  // Structured payloads can contain thousands of short, benign strings. Avoid
  // walking the full default pattern table for each one; the prefilter is kept
  // in sync with every built-in pattern and sensitive form/URL key. Explicit
  // user patterns still require the full scan because they have no prefilter.
  const redacted =
    !usesBuiltInRedactPatterns(fieldOptions.patterns) ||
    couldMatchDefaultRedactPatterns(exactRedacted)
      ? redactText(exactRedacted, resolved.patterns, {
          redactFormBodies: resolved.redactFormBodies,
          redactStructuredAuthHeaders: resolved.redactStructuredAuthHeaders,
        })
      : exactRedacted;
  const shouldRedactAppPassword = redacted !== value || STRUCTURED_APP_PASSWORD_FIELD_RE.test(key);
  if (shouldRedactAppPassword) {
    const appRedacted = redactAppSpecificPasswords(redacted);
    if (appRedacted !== value) {
      return appRedacted;
    }
  }
  if (redacted !== value) {
    return redacted;
  }
  const normalizedStructuredKey = key.toLowerCase();
  if (shouldRedactStructuredAuthorizationCode(normalizedStructuredKey, path)) {
    return maskToken(value);
  }
  if (
    normalizedStructuredKey === "session" &&
    STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE.test(exactRedacted)
  ) {
    return exactRedacted;
  }
  if (sensitiveKey) {
    if (isShellReferenceToKey(key, exactRedacted)) {
      return exactRedacted;
    }
    return maskToken(exactRedacted);
  }
  return exactRedacted;
}

export function redactSensitiveFieldValue(
  key: string,
  value: string,
  options?: RedactOptions,
): string {
  return redactSensitiveFieldValueWithOptions(key, value, options ?? resolveToolPayloadRedaction());
}

export function redactSensitiveFieldValueWithConfig(
  key: string,
  value: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactSensitiveFieldValueWithOptions(
    key,
    value,
    resolveToolPayloadRedaction(loggingConfig),
  );
}

export function redactModelVisibleSensitiveFieldValueWithConfig(
  key: string,
  value: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactSensitiveFieldValueWithOptions(
    key,
    value,
    resolveModelVisibleToolPayloadRedaction(loggingConfig),
  );
}

function pathEndsWith(path: readonly string[], suffix: readonly string[]): boolean {
  if (path.length < suffix.length) {
    return false;
  }
  return suffix.every((part, index) => path[path.length - suffix.length + index] === part);
}

function shouldRedactStructuredAuthorizationCode(
  normalizedKey: string,
  path: readonly string[],
): boolean {
  if (normalizedKey !== "code") {
    return false;
  }
  const normalizedPath = path.map((part) => part.toLowerCase());
  if (
    normalizedPath.length === 1 ||
    pathEndsWith(normalizedPath, ["error", "code"]) ||
    pathEndsWith(normalizedPath, ["nodeerror", "code"]) ||
    pathEndsWith(normalizedPath, ["status", "code"]) ||
    pathEndsWith(normalizedPath, ["details", "code"]) ||
    pathEndsWith(normalizedPath, ["warnings", "code"])
  ) {
    return false;
  }
  return true;
}

function shouldRedactStructuredPrimitiveField(key: string, path: readonly string[]): boolean {
  const normalizedKey = key.toLowerCase();
  return shouldRedactStructuredAuthorizationCode(normalizedKey, path) || isSensitiveFieldKey(key);
}

function isPlainRedactableObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactStructuredSecretValue(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  options: RedactOptions,
  path: readonly string[] = key ? [key] : [],
): unknown {
  if (typeof value === "string") {
    return redactSensitiveFieldValueWithOptions(key, value, options, path);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return shouldRedactStructuredPrimitiveField(key, path) ? "***" : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out = value.map((entry) => redactStructuredSecretValue(key, entry, seen, options, path));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (!isPlainRedactableObject(value)) {
      return value;
    }
    seen.add(value);
    const entries = Object.entries(value);
    for (const entry of entries) {
      const [name, child] = entry;
      entry[1] = redactStructuredSecretValue(name, child, seen, options, [...path, name]);
    }
    seen.delete(value);
    // Define own data properties so JSON field names cannot change the output prototype.
    return Object.fromEntries(entries);
  }
  return value;
}

function redactSecretsWithOptions<T>(value: T, options: RedactOptions): T {
  if (typeof value === "string") {
    return redactSensitiveText(value, options) as T;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  return redactStructuredSecretValue("", value, new WeakSet<object>(), options) as T;
}

export function redactSecrets<T>(value: T): T {
  return redactSecretsWithOptions(value, resolveToolPayloadRedaction());
}

export function redactModelVisibleSecrets<T>(value: T): T {
  return redactSecretsWithOptions(value, resolveModelVisibleToolPayloadRedaction());
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

// Applies already-resolved redaction to a batch of lines without re-resolving options.
// Lines are joined before redacting so multiline patterns (e.g. PEM blocks) can match across
// line boundaries, then split back. Use this instead of mapping redactSensitiveText when
// options are resolved once per request.
export function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[] {
  if (lines.length === 0 || resolved.mode === "off") {
    return lines;
  }
  const exactRedactedLines = lines.map((line) => redactRegisteredSecretValues(line, maskToken));
  if (!resolved.patterns.length) {
    return exactRedactedLines;
  }
  const redactedLines = resolved.redactFormBodies
    ? exactRedactedLines.map((line) => redactFormBody(redactUrlQueryPairs(line)))
    : exactRedactedLines;
  let redacted = redactedLines.join("\n");
  if (resolved.redactStructuredAuthHeaders) {
    redacted = redactStructuredAuthHeaders(redacted, "***");
  }
  return redactText(redacted, resolved.patterns).split("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
