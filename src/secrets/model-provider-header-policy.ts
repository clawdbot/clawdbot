/** Classifies model-provider request headers that should be treated as credential material. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Exact header names that always carry credential material for model provider requests. */
const ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-api-token",
  "api-token",
  "x-access-token",
  "access-token",
  "x-authorization",
  "x-secret-key",
  "secret-key",
  "x-goog-api-key",
  "ocp-apim-subscription-key",
  "private-token",
  "x-vault-token",
  "x-amz-security-token",
  "x-github-token",
  "x-apikey",
]);

// Substring matching catches provider-specific auth headers without forcing every plugin to
// register its own spelling in the shared plaintext-secret audit.
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
];

const OUTBOUND_NON_CREDENTIAL_HEADER_NAMES = new Set([
  "idempotency-key",
  "surrogate-key",
  "x-cache-key",
  "x-idempotency-key",
  "x-trace-token",
]);

const CREDENTIAL_HEADER_NAME_SUFFIX_PATTERN =
  /(?:^|-)(?:auth|authentication|credential|key|password|secret|token)$/u;
const AUTHENTICATION_SIGNATURE_HEADER_NAME_SEGMENT_PATTERN =
  /(?:^|-)(?:auth-sign(?:ature)?|hmac|signature)(?:-|$)/u;

/**
 * Returns whether a header name is unambiguously credential material by exact name.
 * Callers that refuse rather than audit need this narrower answer, because the
 * fragment matching below is deliberately loose enough to flag innocent names.
 */
function isAlwaysCredentialHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized ? ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized) : false;
}

/**
 * Returns whether an operator-configured header name is credential material that
 * must not be forwarded to a model-chosen host.
 *
 * Credential suffixes cover vendor spellings such as Fastly-Key, X-Auth-Key,
 * X-RapidAPI-Key, X-Akamai-ACS-Auth-Sign, and X-Plivo-Signature-V2. The
 * narrow exception list preserves established metadata headers without
 * reopening loose substring matching as a refusal rule.
 */
export function isOutboundCredentialHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized || OUTBOUND_NON_CREDENTIAL_HEADER_NAMES.has(normalized)) {
    return false;
  }
  return (
    isAlwaysCredentialHeaderName(normalized) ||
    CREDENTIAL_HEADER_NAME_SUFFIX_PATTERN.test(normalized) ||
    AUTHENTICATION_SIGNATURE_HEADER_NAME_SEGMENT_PATTERN.test(normalized)
  );
}

/**
 * Returns whether a model-provider header name should be treated as secret-bearing.
 * This is intentionally conservative: false positives are audit noise, false negatives leak keys.
 */
export function isLikelySensitiveModelProviderHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (isAlwaysCredentialHeaderName(normalized)) {
    return true;
  }
  return SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}
