/**
 * Runtime-policy bridge for provider config normalization. These helpers call
 * plugin hooks without triggering runtime plugin loading from config assembly.
 */
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/** Apply provider native-streaming usage compatibility policy. */
export function applyProviderNativeStreamingUsagePolicy(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
  return (
    applyProviderNativeStreamingUsageCompatWithPlugin({
      provider: runtimeProviderKey,
      allowRuntimePluginLoad: false,
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? provider
  );
}

/** Normalize provider config through any already-available plugin policy hook. */
export function normalizeProviderConfigPolicy(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
  return (
    normalizeProviderConfigWithPlugin({
      provider: runtimeProviderKey,
      allowRuntimePluginLoad: false,
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? provider
  );
}

/** Resolve a provider API-key policy function from already-available plugin hooks. */
export function resolveProviderConfigApiKeyPolicy(
  providerKey: string,
  provider?: ProviderConfig,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
  return (env) =>
    resolveProviderConfigApiKeyWithPlugin({
      provider: runtimeProviderKey,
      allowRuntimePluginLoad: false,
      context: {
        provider: providerKey,
        env,
      },
    });
}
