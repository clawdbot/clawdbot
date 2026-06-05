/**
 * Applies provider plugin policy to configured model provider settings.
 */
import {
  applyProviderNativeStreamingUsagePolicy,
  normalizeProviderConfigPolicy,
  resolveProviderConfigApiKeyPolicy,
} from "./models-config.providers.policy.runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/**
 * Provider-specific config policy adapters.
 *
 * Runtime policy rules live in the sibling runtime module; this file exposes the
 * small stable API used by models-config loading and tests.
 */
/** Applies native-streaming usage compatibility policy to the provider map. */
export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const nextProvider = applyProviderNativeStreamingUsagePolicy(providerKey, provider);
    nextProviders[providerKey] = nextProvider;
    changed ||= nextProvider !== provider;
  }

  return changed ? nextProviders : providers;
}

/** Normalizes a provider config according to provider-specific runtime policy. */
export function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  const normalized = normalizeProviderConfigPolicy(providerKey, provider);
  if (normalized && normalized !== provider) {
    return normalized;
  }
  return provider;
}

/** Resolves a provider-specific API key env lookup policy when one exists. */
export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
  provider?: ProviderConfig,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  return resolveProviderConfigApiKeyPolicy(providerKey, provider);
}
