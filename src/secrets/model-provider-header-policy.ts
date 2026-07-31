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
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
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

/**
 * Returns whether a model-provider header name should be treated as secret-bearing.
 * This is intentionally conservative: false positives are audit noise, false negatives leak keys.
 */
export function isLikelySensitiveModelProviderHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}
