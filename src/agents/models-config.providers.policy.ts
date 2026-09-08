import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export type ProviderPolicyManifestRegistry = Pick<PluginManifestRegistry, "plugins">;

/**
 * Provider-specific config policy adapters.
 *
 * These helpers call plugin hooks without triggering runtime plugin loading
 * from config assembly.
 */
/** Normalizes a provider config according to provider-specific runtime policy. */
export function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
  manifestRegistry?: ProviderPolicyManifestRegistry,
): ProviderConfig {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
  return (
    normalizeProviderConfigWithPlugin({
      provider: runtimeProviderKey,
      allowRuntimePluginLoad: false,
      ...(manifestRegistry ? { manifestRegistry } : {}),
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? provider
  );
}

/** Resolves a provider-specific API key env lookup policy when one exists. */
export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
  provider?: ProviderConfig,
  manifestRegistry?: ProviderPolicyManifestRegistry,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
  return (env) =>
    resolveProviderConfigApiKeyWithPlugin({
      provider: runtimeProviderKey,
      allowRuntimePluginLoad: false,
      ...(manifestRegistry ? { manifestRegistry } : {}),
      context: {
        provider: providerKey,
        env,
      },
    });
}
