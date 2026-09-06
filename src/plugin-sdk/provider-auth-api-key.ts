/**
 * Public SDK subpath for API-key provider auth setup and secret input handling.
 */
export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";

export {
  upsertAuthProfile,
  upsertAuthProfileWithLockOrThrow,
} from "../agents/auth-profiles/profiles.js";
export { upsertAuthProfileWithLockCompat as upsertAuthProfileWithLock } from "./provider-auth-write-compat.js";
export {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../plugins/provider-auth-input.js";
export {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  upsertApiKeyProfile,
  type ApiKeyStorageOptions,
} from "../plugins/provider-auth-helpers.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
