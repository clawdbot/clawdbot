/**
 * Shared model-auth facade. Implementation lives in responsibility-focused modules.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  resolveModelAuthMode as resolveModelAuthModeImpl,
  type ModelAuthMode,
} from "./model-auth-model.js";
import {
  resolveApiKeyForProvider as resolveApiKeyForProviderImpl,
  type ProviderCredentialPrecedence,
} from "./model-auth-provider.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

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
} from "./model-auth-model.js";
export type { ModelAuthMode } from "./model-auth-model.js";
export {
  canUseProfileAsProviderEntryApiKey,
  getCustomProviderApiKey,
  hasUsableCustomProviderApiKey,
  resolveProviderEntryApiKeyBinding,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
  shouldPreferExplicitConfigApiKeyAuth,
} from "./model-auth-provider-config.js";
export type { ProviderEntryApiKeyBindingResolution } from "./model-auth-provider-config.js";
export type { ProviderCredentialPrecedence } from "./model-auth-provider.js";
export {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  hasSyntheticLocalProviderAuthConfig,
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

export async function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  lockedProfile?: boolean;
  forceRefresh?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
  allowAuthProfileFallback?: boolean;
  skipSetupProviderFallback?: boolean;
  modelId?: string;
  modelApi?: string;
  secretSentinels?: boolean;
}): Promise<ResolvedProviderAuth> {
  return resolveApiKeyForProviderImpl(params);
}

export function resolveModelAuthMode(
  provider?: string,
  cfg?: OpenClawConfig,
  store?: AuthProfileStore,
  options?: { workspaceDir?: string },
): ModelAuthMode | undefined {
  return resolveModelAuthModeImpl(provider, cfg, store, options);
}
