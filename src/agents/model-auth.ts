/** Shared model-auth facade for runtime, Plugin SDK, and test import boundaries. */

export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
export { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
export { resolveEnvApiKey } from "./model-auth-env.js";
export type { EnvApiKeyResult } from "./model-auth-env.js";
export {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  applySecretRefHeaderSentinels,
  getApiKeyForModel,
  hasAvailableAuthForProvider,
  resolveModelAuthMode,
} from "./model-auth-model.js";
export type { ModelAuthMode } from "./model-auth-model.js";
export {
  canUseProfileAsProviderEntryApiKey,
  getCustomProviderApiKey,
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
  isConfigBackedInlineProviderApiKey,
  resolveProviderEntryApiKeyBinding,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
  shouldPreferExplicitConfigApiKeyAuth,
} from "./model-auth-provider-config.js";
export type { ProviderEntryApiKeyBindingResolution } from "./model-auth-provider-config.js";
export { resolveApiKeyForProvider } from "./model-auth-provider.js";
export type { ProviderCredentialPrecedence } from "./model-auth-provider.js";
export {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
} from "./model-auth-runtime.js";
export type { RuntimeProviderAuthLookup } from "./model-auth-runtime.js";
export {
  formatMissingAuthError,
  isMissingProviderAuthError,
  isProviderAuthError,
  MissingProviderAuthError,
  ProviderAuthError,
  requireApiKey,
  resolveAwsSdkEnvVarName,
} from "./model-auth-runtime-shared.js";
export type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
