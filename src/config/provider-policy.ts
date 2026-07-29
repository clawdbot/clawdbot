// Resolves provider policy settings from config and plugin metadata.
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveBundledProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import type { ModelProviderConfig, OpenClawConfig } from "./types.js";

/** Applies bundled provider-owned normalization to one provider config during config defaults. */
export function normalizeProviderConfigForConfigDefaults(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): ModelProviderConfig {
  const normalized = resolveBundledProviderPolicySurface(params.provider, {
    manifestRegistry: params.manifestRegistry,
  })?.normalizeConfig?.({
    provider: params.provider,
    providerConfig: params.providerConfig,
  });
  // Preserve object identity when the provider policy declines to change config; defaults callers
  // use identity to avoid unnecessary config rewrites.
  return normalized && normalized !== params.providerConfig ? normalized : params.providerConfig;
}

/** Applies bundled provider-owned defaults to the full config when that provider has policy. */
export function applyProviderConfigDefaultsForConfig(params: {
  provider: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): OpenClawConfig {
  return (
    resolveBundledProviderPolicySurface(params.provider, {
      manifestRegistry: params.manifestRegistry,
    })?.applyConfigDefaults?.({
      provider: params.provider,
      config: params.config,
      env: params.env,
    }) ?? params.config
  );
}
