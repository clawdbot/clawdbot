import {
  HTTP_AUTH_HEADER_BOUNDARY_PATTERN,
  HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN,
  HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_SCHEME_PATTERN,
  HTTP_AUTH_SERIALIZED_QUOTE_PATTERN,
} from "../../packages/acp-core/src/structured-auth-redaction.js";

export const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
export const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
export const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
export const AWS_SECRET_ACCESS_KEY_FIELD_KEYS = String.raw`aws[-_]?secret[-_]?access[-_]?key|awsSecretAccessKey|SecretAccessKey`;
const AUTH_QUERY_KEYS = String.raw`access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|app[-_]?secret|private[-_]?key|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|token|key|secret|password|pass|passwd|auth|jwt|session|code|signature|x[-_]?amz[-_]?(?:signature|security[-_]?token)`;
const FORM_BODY_FIRST_PAIR_KEYS = String.raw`${AUTH_QUERY_KEYS}|app[-_]?secret|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const STANDALONE_ASSIGNMENT_SECRET_KEYS = String.raw`access_token|refresh_token|id_token|auth[-_]?token|hook[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|private[-_]?key|authorization|jwt|token|secret|password|pass|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_ASSIGNMENT_SECRET_KEYS = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_DIRECT_ASSIGNMENT_SECRET_KEYS = String.raw`access-token|refresh-token|id-token|auth-token|hook-token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|passphrase`;
const CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS = String.raw`password|passphrase|pass|passwd`;
const CLI_SECRET_FLAG_KEYS = String.raw`${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|api[-_]?key|hook[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;

export const BODY_SECRET_KEYS = new Set([
  "access_token",
  "auth_token",
  "awssecretaccesskey",
  "aws_secret_access_key",
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
  "secretaccesskey",
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

export const FORM_BODY_KEY_INVISIBLE_CHARS = String.raw`\p{C}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0`;
const ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`;
const ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`;
// Quoted values may contain the other quote characters; only the matching closing quote ends
// the value. The unquoted variant accepts one leading quote so unterminated values still mask.
const STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60])((?:(?!\2)[^\r\n])+)\2`;
const STANDALONE_ASSIGNMENT_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60]?[^\s&#"'\x60<>]+)`;
const CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:(?:${CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*)(["'\x60])((?:(?!\2)[^\r\n])+)\2/g`;
const CONFIG_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})(?:\s*:\s*|\s+=\s*|=\s+)([^\s#"'\x60<>]+)/g`;
const CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:${CONFIG_DIRECT_ASSIGNMENT_SECRET_KEYS})=([^\s#"'\x60<>]+)/g`;
const CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*([^\s#"'\x60<>]+)/g`;
const CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*([^\s#"'\x60<>]+)/g`;
const STRUCTURED_JSON_SECRET_REDACT_PATTERN = String.raw`"(?:apiKey|api_key|apiToken|api_token|bearerToken|bearer_token|token|secret|password|passwd|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|authToken|auth_token|clientSecret|client_secret|privateKey|private_key|secret_value|raw_secret|secret_input|key_material)"\s*:\s*"([^"]+)"`;
const STRUCTURED_JSON_PAYMENT_REDACT_PATTERN = String.raw`"(?:${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`;
const AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN = String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|id[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret|private[-_]key|credential|authorization|secret[-_]value|raw[-_]secret|secret[-_]input|key[-_]material)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`;
const AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN = String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`;
// Pure-base64 prefixes require a non-alphanumeric boundary and skip explicit data-URL payloads.
export const BASE64_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9])(?<!;base64,[A-Za-z0-9+/=]*)`;
export const IDENTIFIER_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9_])`;
const AWS_SECRET_ACCESS_KEY_VALUE_BOUNDARY = String.raw`(^|[^A-Za-z0-9/+=_])(?<!;base64,[A-Za-z0-9+/=]*)`;
export const AWS_SECRET_ACCESS_KEY_VALUE_PATTERN = String.raw`(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[^A-Fa-f0-9])[A-Za-z0-9/+=]{40}`;
const AWS_SECRET_ACCESS_KEY_VALUE_REDACT_PATTERN = String.raw`/${AWS_SECRET_ACCESS_KEY_VALUE_BOUNDARY}(${AWS_SECRET_ACCESS_KEY_VALUE_PATTERN})(?!_)/g`;
const TELEGRAM_BOT_TOKEN_REDACT_PATTERN = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const TELEGRAM_TOKEN_REDACT_PATTERN = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const CREDENTIAL_STYLE_HEADER_KEYS = "x-goog-api-key|api-key|apikey|x-api-token|x-access-token";
const GATEWAY_SECURITY_HEADER_KEYS =
  "X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token";
// Colons identify HTTP headers. Equals assignments may be form bodies, so stop only before an
// actual following `&key=` pair; otherwise opaque credential punctuation stays fully masked.
const LOG_HEADER_BOUNDARY_PATTERN = String.raw`(^|[^A-Za-z0-9_?&-]|\\{1,64}[rn])`;
const CREDENTIAL_STYLE_COLON_HEADER_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${CREDENTIAL_STYLE_HEADER_KEYS})${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*:${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}([^\s\\"',;]+)`;
const CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${CREDENTIAL_STYLE_HEADER_KEYS})${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*=${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}([^\s\\"',;]+)`;
const GATEWAY_SECURITY_COLON_HEADER_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${GATEWAY_SECURITY_HEADER_KEYS})\s*:\s*([^\s"',;]+)`;
const GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${GATEWAY_SECURITY_HEADER_KEYS})\s*=\s*([^\s"',;]+)`;
export const FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES = new Set([
  CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN,
  GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN,
]);
const HTTP_AUTH_HEADER_REDACT_PATTERNS = [
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  CREDENTIAL_STYLE_COLON_HEADER_REDACT_PATTERN,
  CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN,
] as const;
const AUTHORIZATION_BEARER_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bearer${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BASIC_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Basic${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BOT_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bot${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const STANDALONE_BEARER_REDACT_PATTERN = String.raw`\bBearer\s+([-A-Za-z0-9._~+/=]{18,})(?![-A-Za-z0-9._~+/=])`;
export const SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES = new Set([
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
]);
export const CHUNK_UNSAFE_PATTERN_SOURCES = new Set([
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
  AUTHORIZATION_BEARER_REDACT_PATTERN,
  AUTHORIZATION_BASIC_REDACT_PATTERN,
  AUTHORIZATION_BOT_REDACT_PATTERN,
  STANDALONE_BEARER_REDACT_PATTERN,
  AWS_SECRET_ACCESS_KEY_VALUE_REDACT_PATTERN,
  ...HTTP_AUTH_HEADER_REDACT_PATTERNS,
]);

export const DEFAULT_REDACT_PATTERNS: readonly string[] = [
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STRUCTURED_JSON_SECRET_REDACT_PATTERN,
  STRUCTURED_JSON_PAYMENT_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN,
  String.raw`--(?:${CLI_SECRET_FLAG_KEYS})=([^\s"']+)`,
  String.raw`--(?:${CLI_SECRET_FLAG_KEYS})\s+(?!(?:or|and)\b(?=\s+--))(["']?)([^\s"']+)\1`,
  AUTHORIZATION_BEARER_REDACT_PATTERN,
  AUTHORIZATION_BASIC_REDACT_PATTERN,
  AUTHORIZATION_BOT_REDACT_PATTERN,
  ...HTTP_AUTH_HEADER_REDACT_PATTERNS,
  GATEWAY_SECURITY_COLON_HEADER_REDACT_PATTERN,
  GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN,
  STANDALONE_BEARER_REDACT_PATTERN,
  String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`,
  String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`,
  String.raw`(^|[\s,;])(?:${FORM_BODY_FIRST_PAIR_KEYS})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  String.raw`(^|[\s,{])["']?(?:${AWS_SECRET_ACCESS_KEY_FIELD_KEYS})["']?\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])\2`,
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`(ghp_[A-Za-z0-9]{10,})`,
  String.raw`(github_pat_[A-Za-z0-9_]{10,})`,
  String.raw`(gho_[A-Za-z0-9]{10,})`,
  String.raw`(ghu_[A-Za-z0-9]{10,})`,
  String.raw`(ghs_[A-Za-z0-9]{10,})`,
  String.raw`(ghr_[A-Za-z0-9]{10,})`,
  String.raw`(glpat-[A-Za-z0-9._=\-]{20,})`,
  String.raw`(gloas-(?:[A-Fa-f0-9]{65,}|[A-Za-z0-9_-]{64}|[A-Fa-f0-9]{32,}))`,
  String.raw`(gldt-[A-Za-z0-9_-]{20,})`,
  String.raw`(glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20,})`,
  String.raw`(glptt-[A-Za-z0-9_-]{40,})`,
  String.raw`(glft-(?:[A-Za-z0-9_-]{20,}|[a-h0-9]+-[0-9]+_))`,
  String.raw`(glimt-[A-Za-z0-9_-]{25,})`,
  String.raw`(glagent-[A-Za-z0-9_-]{50,})`,
  String.raw`(glwt-[A-Za-z0-9_-]{20,})`,
  String.raw`(glsoat-[A-Za-z0-9_-]{20,})`,
  String.raw`(glffct-[A-Za-z0-9_-]{20,})`,
  String.raw`(glrt-[A-Za-z0-9._-]{20,})`,
  String.raw`(glrtr?-[A-Za-z0-9_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9})`,
  String.raw`(GR1348941[A-Za-z0-9_-]{20,})`,
  String.raw`(_gitlab_session=[A-Za-z0-9%._-]{20,})`,
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
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(AKIA[A-Z0-9]{16})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ASIA[A-Z0-9]{16})`,
  String.raw`(AKID[A-Za-z0-9]{10,})`,
  String.raw`(LTAI[A-Za-z0-9]{10,})`,
  String.raw`(hf_[A-Za-z0-9]{10,})`,
  String.raw`(api_org_[A-Za-z0-9]{20,})`,
  String.raw`(r8_[A-Za-z0-9]{10,})`,
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
  AWS_SECRET_ACCESS_KEY_VALUE_REDACT_PATTERN,
];

const TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS = new Set([
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STRUCTURED_JSON_SECRET_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN,
]);

// Tool output commonly contains source code. Keep key-name matching in logs, direct `.env` reads,
// and payment JSON; other model-visible text relies on registered and recognizable secret values.
export const TOOL_PAYLOAD_REDACT_PATTERNS: readonly string[] = DEFAULT_REDACT_PATTERNS.filter(
  (pattern) => !TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS.has(pattern),
);
