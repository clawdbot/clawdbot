/**
 * Runtime SDK subpath for secret input normalization and configured secret resolution.
 */
export {
  coerceSecretRef,
  hasConfiguredSecretInput,
  isSecretRef,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
  type SecretInput,
  type SecretInputStringResolution,
  type SecretInputStringResolutionMode,
} from "../config/types.secrets.js";
export {
  resolveConfiguredSecretInputString,
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "../gateway/resolve-configured-secret-input-string.js";
