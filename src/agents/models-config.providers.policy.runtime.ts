import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

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
