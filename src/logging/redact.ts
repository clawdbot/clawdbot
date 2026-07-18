import {
  CREDENTIAL_STYLE_HEADER_REDACT_PATTERN,
  findStructuredAuthParamRanges,
  HTTP_AUTH_HEADER_BOUNDARY_PATTERN,
  HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN,
  HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_SCHEME_PATTERN,
  HTTP_AUTH_SERIALIZED_QUOTE_PATTERN,
  redactStructuredAuthHeaders,
} from "@openclaw/acp-core";
import { expectDefined } from "@openclaw/normalization-core";
// Redaction helpers scrub secrets and sensitive identifiers from log output.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { replacePatternBounded } from "./redact-bounded.js";
import { isFullContextToolPayloadRedaction } from "./redact-internal.js";
import { redactRegisteredSecretValues } from "./secret-redaction-registry.js";

export type RedactSensitiveMode = "off" | "tools";
export type RedactPattern = string | RegExp;
type LoggingConfig = OpenClawConfig["logging"];

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
const AUTH_QUERY_KEYS = String.raw`access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|app[-_]?secret|private[-_]?key|credential|authorization|token|key|secret|password|pass|passwd|auth|jwt|session|code|signature|x[-_]?amz[-_]?(?:signature|security[-_]?token)`;
const FORM_BODY_FIRST_PAIR_KEYS = String.raw`${AUTH_QUERY_KEYS}|app[-_]?secret|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const STANDALONE_ASSIGNMENT_SECRET_KEYS = String.raw`access_token|refresh_token|id_token|auth[-_]?token|hook[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|private[-_]?key|authorization|jwt|token|secret|password|pass|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const BODY_SECRET_KEYS = new Set([
  "access_token",
  "auth_token",
  "hook_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "client_secret",
  "app_secret",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "code",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "secret",
  "credential",
  "private_key",
  "authorization",
  "key",
  "card_number",
  "card_cvc",
  "card_cvv",
  "cvc",
  "cvv",
  "security_code",
  "payment_credential",
  "shared_payment_token",
]);
const FORM_BODY_KEY_INVISIBLE_CHARS = String.raw`\p{C}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0`;
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
const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
const STRUCTURED_SECRET_FIELD_RE = new RegExp(
  String.raw`^(?:api[-_]?key|apiKey|api[-_]?token|apiToken|bearer[-_]?token|bearerToken|token|secret|password|passwd|credential|authorization|private[-_]?key|privateKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|secret[-_]?value|secretValue|raw[-_]?secret|rawSecret|secret[-_]?input|secretInput|key|key[-_]?material|keyMaterial|jwt|session|signature|cookie|set[-_]?cookie|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`,
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

const ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`;
const ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`;
// Quoted values may contain the other quote characters (`password="it's"`); only the matching
// closing quote ends the value. The unquoted variant accepts one leading quote so unterminated
// quotes still mask like plain values instead of escaping both patterns.
const STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60])((?:(?!\2)[^\r\n])+)\2`;
const STANDALONE_ASSIGNMENT_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60]?[^\s&#"'\x60<>]+)`;
// Pure-base64-alphabet token prefixes: require a non-alphanumeric left boundary (URL/path
// delimiters like `/` and `=` still qualify) but skip explicit `;base64,` payload spans, so
// data-URL media is never corrupted while tokens in URL paths or assignments still redact.
const BASE64_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9])(?<!;base64,[A-Za-z0-9+/=]*)`;
const IDENTIFIER_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9_])`;
const TELEGRAM_BOT_TOKEN_REDACT_PATTERN = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const TELEGRAM_TOKEN_REDACT_PATTERN = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const HTTP_AUTH_HEADER_REDACT_PATTERNS = [
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  CREDENTIAL_STYLE_HEADER_REDACT_PATTERN,
] as const;
const AUTHORIZATION_BEARER_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bearer${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BASIC_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Basic${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BOT_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bot${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const STANDALONE_BEARER_REDACT_PATTERN = String.raw`\bBearer\s+([-A-Za-z0-9._~+/=]{18,})(?![-A-Za-z0-9._~+/=])`;
const SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES = new Set([
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
]);
const CHUNK_UNSAFE_PATTERN_SOURCES = new Set([
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
  AUTHORIZATION_BEARER_REDACT_PATTERN,
  AUTHORIZATION_BASIC_REDACT_PATTERN,
  AUTHORIZATION_BOT_REDACT_PATTERN,
  STANDALONE_BEARER_REDACT_PATTERN,
  ...HTTP_AUTH_HEADER_REDACT_PATTERNS,
]);
const shellReferencePreservingPatterns = new WeakSet<RegExp>();
// Patterns whose left-context assertions or complete token can cross a chunk boundary must run
// against the full string; chunking can invent a `^` boundary or split the secret itself.
const chunkUnsafePatterns = new WeakSet<RegExp>();

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments. Keep this case-sensitive so diagnostics like
  // `Unrecognized key: "llm"` do not lose the actual config key.
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  // URL query parameters. Keep this separate from ENV-style assignments so
  // lower-case URL secrets stay redacted without hiding config-key diagnostics.
  String.raw`/[?&](?:${AUTH_QUERY_KEYS}|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^&#\s<>]+)/gi`,
  // JSON fields.
  String.raw`"(?:apiKey|api_key|apiToken|api_token|bearerToken|bearer_token|token|secret|password|passwd|credential|authorization|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|authToken|auth_token|clientSecret|client_secret|privateKey|private_key|secret_value|raw_secret|secret_input|key_material|${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`,
  // HTTP client diagnostics often stringify request config objects using
  // JSON or util.inspect-style fields rather than env/CLI syntax.
  String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|id[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret|private[-_]key|credential|authorization|secret[-_]value|raw[-_]secret|secret[-_]input|key[-_]material)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
  String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
  // CLI flags.
  String.raw`--(?:api[-_]?key|hook[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret|${PAYMENT_CREDENTIAL_QUERY_KEYS})\s+(?!(?:or|and)\b(?=\s+--))(["']?)([^\s"']+)\1`,
  // Authorization headers.
  AUTHORIZATION_BEARER_REDACT_PATTERN,
  AUTHORIZATION_BASIC_REDACT_PATTERN,
  AUTHORIZATION_BOT_REDACT_PATTERN,
  ...HTTP_AUTH_HEADER_REDACT_PATTERNS,
  String.raw`(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)`,
  STANDALONE_BEARER_REDACT_PATTERN,
  // URL userinfo and common connection-string password slots.
  String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`,
  String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`,
  // First pair in form-urlencoded bodies embedded in larger log lines.
  String.raw`(^|[\s,;])(?:${FORM_BODY_FIRST_PAIR_KEYS})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`,
  // Standalone token assignments in CLI or HTTP diagnostics. URL query params
  // are handled above so non-secret params survive and long values stay hinted.
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  // Common token prefixes.
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`(ghp_[A-Za-z0-9]{10,})`,
  String.raw`(github_pat_[A-Za-z0-9_]{10,})`,
  String.raw`(gho_[A-Za-z0-9]{10,})`,
  String.raw`(ghu_[A-Za-z0-9]{10,})`,
  String.raw`(ghs_[A-Za-z0-9]{10,})`,
  String.raw`(ghr_[A-Za-z0-9]{10,})`,
  String.raw`(glpat-[A-Za-z0-9._=\-]{20,})`,
  String.raw`(gloas-[A-Fa-f0-9]{32,})`,
  String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
  String.raw`(xapp-[A-Za-z0-9-]{10,})`,
  String.raw`(https:\/\/hooks\.slack\.com\/(?:services\/T[A-Z0-9]+\/B[A-Z0-9]+|workflows\/T[A-Z0-9]+\/A[A-Z0-9]+\/[0-9]{17,19})\/[A-Za-z0-9]{20,})`,
  String.raw`(https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,})`,
  String.raw`discord(?:.|\n|\r){0,40}?\b([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b`,
  String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
  String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
  String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
  String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
  String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
  String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
  String.raw`(fal_[A-Za-z0-9_-]{10,})`,
  String.raw`(fc-[A-Za-z0-9]{10,})`,
  String.raw`(bb_live_[A-Za-z0-9_-]{10,})`,
  // Prefixes made only of standard-base64 characters need a non-base64 left boundary so they
  // do not fire inside unrelated base64 blobs (e.g. data-URL media), corrupting the payload.
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(gAAAA[A-Za-z0-9_=-]{20,})`,
  String.raw`(sk_live_[A-Za-z0-9]{10,})`,
  String.raw`(sk_test_[A-Za-z0-9]{10,})`,
  String.raw`(rk_live_[A-Za-z0-9]{10,})`,
  String.raw`(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
  String.raw`(npm_[A-Za-z0-9]{10,})`,
  String.raw`(pypi-[A-Za-z0-9_-]{10,})`,
  String.raw`(dop_v1_[A-Za-z0-9]{10,})`,
  String.raw`(doo_v1_[A-Za-z0-9]{10,})`,
  String.raw`(dor_v1_[A-Za-z0-9]{10,})`,
  String.raw`(dp\.(?:ct|pt|sa|scim|audit)\.[A-Za-z0-9]{40,44})`,
  String.raw`(dp\.st\.[A-Za-z0-9]{40,44})`,
  String.raw`(dp\.st\.[a-z0-9_-]{2,35}\.[A-Za-z0-9]{40,44})`,
  String.raw`(dckr_(?:pat|oat)_[A-Za-z0-9_-]{27,32})`,
  String.raw`(bkua_[a-z0-9]{40})`,
  String.raw`(CCIPAT_[A-Za-z0-9]{22}_[A-Fa-f0-9]{40})`,
  String.raw`(sbp_[a-z0-9]{40})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(dapi[0-9a-f]{32}(?:-\d)?)`,
  String.raw`(dd[pw]_[A-Za-z0-9]{36})`,
  String.raw`(glsa_[A-Za-z0-9_]{41})`,
  String.raw`(glc_eyJ[A-Za-z0-9+/=]{60,160})`,
  String.raw`(nfp_[A-Za-z0-9_]{36})`,
  String.raw`(CFPAT-[A-Za-z0-9_\-]{40,})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATBB[A-Za-z0-9_=.-]{16,})`,
  String.raw`(BBDC-[A-Za-z0-9+/@_-]{40,50})`,
  String.raw`(HRKU-AA[A-Za-z0-9_-]{20,})`,
  String.raw`(pat-(?:eu|na)1-[A-Za-z0-9]{8}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{12})`,
  String.raw`(apify_api_[A-Za-z0-9\-]{20,})`,
  String.raw`(FlyV1 fm\d+_[A-Za-z0-9+/=,_-]{100,})`,
  String.raw`(fio-u-[A-Za-z0-9_-]{40,})`,
  String.raw`(^|[^A-Za-z0-9_])(am_[A-Za-z0-9_-]{10,})`,
  String.raw`(^|[^A-Za-z0-9_])(sk_[A-Za-z0-9_]{10,})`,
  String.raw`(tvly-[A-Za-z0-9]{10,})`,
  String.raw`(exa_[A-Za-z0-9]{10,})`,
  String.raw`(syt_[A-Za-z0-9]{10,})`,
  String.raw`(retaindb_[A-Za-z0-9]{10,})`,
  String.raw`(hsk-[A-Za-z0-9]{10,})`,
  String.raw`(mem0_[A-Za-z0-9]{10,})`,
  String.raw`(brv_[A-Za-z0-9]{10,})`,
  String.raw`(xai-[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fw-[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fw_[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fpk_[A-Za-z0-9]{30,})`,
  // Additional access-key and token-style prefixes.
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(AKIA[A-Z0-9]{16})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ASIA[A-Z0-9]{16})`,
  String.raw`(AKID[A-Za-z0-9]{10,})`,
  String.raw`(LTAI[A-Za-z0-9]{10,})`,
  String.raw`(hf_[A-Za-z0-9]{10,})`,
  String.raw`(api_org_[A-Za-z0-9]{20,})`,
  String.raw`(r8_[A-Za-z0-9]{10,})`,
  // Telegram Bot API URLs embed the token as `/bot<token>/...` (no word-boundary before digits).
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
];
let defaultResolvedPatterns: RegExp[] | undefined;

// Fast-path gate: with no user-configured patterns, redactSensitiveText skips the full
// default-pattern walk unless one of these triggers matches. Every DEFAULT_REDACT_PATTERNS
// entry and sensitive form/URL key must stay reachable here — a missing trigger silently
// leaks that secret shape, so each family keeps a default-options fixture in redact.test.ts.
const DEFAULT_REDACT_PREFILTER_SOURCES: string[] = [
  // Sensitive key names shared by the env/JSON/query/form/header/assignment families.
  String.raw`KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SIGNATURE|CREDENTIAL|CARD|CVC|CVV|PAYMENT|PRIVATE KEY`,
  String.raw`security[-_]?code|\bpass=|jwt=|session=|code=`,
  String.raw`\bBearer\s+`,
  // URL userinfo and connection-string password slots (`scheme://user:pass@host`).
  String.raw`:\/\/[^\/\s:@]*:[^\/\s@]+@`,
  // Vendor token prefixes and webhook hosts, ordered like DEFAULT_REDACT_PATTERNS.
  String.raw`sk-|gh[opsur]_|github_pat_|glpat-|gloas-|xox[baprs]-|xapp-|hooks\.slack\.com|discord|gsk_|AIza|ya29\.|1\/\/0|eyJ|pplx-|fal_|fc-|bb_live_|gAAAA|[sr]k_(?:live|test)_|\bSG\.|npm_|pypi-|do[opr]_v1_|dp\.(?:ct|pt|sa|st|scim|audit)\.|dckr_|bkua_|CCIPAT_|sbp_|dapi[0-9a-f]|dd[pw]_|glsa_|nfp_|CFPAT-|ATCTT3|ATATT|ATBB|BBDC-|HRKU-|pat-(?:eu|na)1-|apify_api_|FlyV1|fio-u-|tvly-|exa_|syt_|retaindb_|mem0_|brv_|xai-|fw-|fw_|fpk_`,
  String.raw`(?:^|[^A-Za-z0-9_])(?:am_|sk_)`,
  String.raw`A[KS]IA[A-Z0-9]|AKID|LTAI|hf_|api_org_|r8_`,
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

export type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: RedactPattern[];
};

export type ResolvedRedactOptions = {
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

function resolvePatterns(value?: RedactPattern[]): RegExp[] {
  if (!value?.length) {
    defaultResolvedPatterns ??= DEFAULT_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is RegExp => Boolean(re),
    );
    return defaultResolvedPatterns;
  }
  return value.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function includesDefaultRedactPatterns(value?: RedactPattern[]): boolean {
  if (!value?.length) {
    return true;
  }
  const source = new Set(value.filter((pattern): pattern is string => typeof pattern === "string"));
  return DEFAULT_REDACT_PATTERNS.every((pattern) => source.has(pattern));
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
  return BODY_SECRET_KEYS.has(normalizeSensitiveKeyName(key));
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
    if (!hasEncodedOrInvisibleFormKey(key) || !isSensitiveBodyKey(key)) {
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
    if (!hasEncodedOrInvisibleFormKey(key) || !isSensitiveBodyKey(key)) {
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
  context?: { input?: string; offset?: number },
): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const selected = selectSecretCapture(match, groups);
  const token = selected.value;
  // An earlier pass (form-body or quoted-assignment masking) may already have replaced this
  // value with ***; re-masking would strip its quote wrapper around the placeholder.
  if (splitSecretValueForMask(token).maskable === "***") {
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
  const masked = isShellReferencePattern
    ? maskToken(token)
    : maskSecretValue(token, { hinted: true });
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
      return redactMatch(match, groups, pattern, { input, offset });
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
  const secretValue = splitSecretValueForMask(selected.value);
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
  const bitmap: boolean[] = Array.from({ length: text.length }, () => false);
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
    mode: normalizeMode(cfg?.redactSensitive),
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
  if (!resolvedOptions.patterns?.length && !couldMatchDefaultRedactPatterns(exactRedacted)) {
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

// Forces tools-mode regardless of `logging.redactSensitive` (which governs log
// output, not UI surfaces), and merges user `logging.redactPatterns` with the
// built-in defaults so both apply.
export function redactToolPayloadText(text: string): string {
  return redactToolPayloadTextWithConfig(text, readLoggingConfig());
}

export function redactToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  if (!text) {
    return text;
  }
  const exactRedacted = redactRegisteredSecretValues(text, maskToken);
  if (isFullContextToolPayloadRedaction(loggingConfig)) {
    const resolved = resolveRedactOptions(resolveToolPayloadRedaction(loggingConfig));
    return redactText(exactRedacted, resolved.patterns, {
      fullContext: true,
      redactFormBodies: resolved.redactFormBodies,
      redactStructuredAuthHeaders: resolved.redactStructuredAuthHeaders,
    });
  }
  return redactSensitiveText(text, resolveToolPayloadRedaction(loggingConfig));
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
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return exactRedacted;
  }
  const redacted = redactText(exactRedacted, resolved.patterns, {
    redactFormBodies: resolved.redactFormBodies,
    redactStructuredAuthHeaders: resolved.redactStructuredAuthHeaders,
  });
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
  if (isSensitiveFieldKey(key)) {
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
    const out: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      out[nestedKey] = redactStructuredSecretValue(nestedKey, nestedValue, seen, options, [
        ...path,
        nestedKey,
      ]);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

export function redactSecrets<T>(value: T): T {
  const options = resolveToolPayloadRedaction();
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

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

// Applies already-resolved redaction to a batch of lines without re-resolving options.
// Lines are joined before redacting so multiline patterns (e.g. PEM blocks) can match across
// line boundaries, then split back. Use this instead of mapping redactSensitiveText when
// options are resolved once per request.
export function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[] {
  if (resolved.mode === "off" || !resolved.patterns.length || lines.length === 0) {
    return lines;
  }
  const redactedLines = resolved.redactFormBodies
    ? lines.map((line) => redactFormBody(redactUrlQueryPairs(line)))
    : lines;
  let redacted = redactedLines.join("\n");
  if (resolved.redactStructuredAuthHeaders) {
    redacted = redactStructuredAuthHeaders(redacted, "***");
  }
  return redactText(redacted, resolved.patterns).split("\n");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
