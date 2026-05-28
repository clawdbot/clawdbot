import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";

type ProviderAliasSource = {
  cfg: OpenClawConfig;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

function listManifestPlugins(params: ProviderAliasSource): readonly PluginManifestRecord[] {
  return params.metadataSnapshot?.manifestRegistry.plugins ?? loadPluginManifestRegistry({
    config: params.cfg,
  }).plugins;
}

function buildProviderAliasMap(params: ProviderAliasSource): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const plugin of listManifestPlugins(params)) {
    for (const [aliasProvider, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const alias = normalizeProviderId(aliasProvider);
      const provider = normalizeProviderId(target.provider);
      if (alias && provider) {
        aliases.set(alias, provider);
      }
    }
  }
  return aliases;
}

export function createModelCatalogProviderAliasCanonicalizer(params: ProviderAliasSource): {
  provider: (provider: string) => string;
  ref: <TRef extends { provider: string }>(ref: TRef) => TRef;
} {
  const aliases = buildProviderAliasMap(params);
  const provider = (providerId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
  return {
    provider,
    ref: (ref) => {
      const canonicalProvider = provider(ref.provider);
      return canonicalProvider === ref.provider ? ref : { ...ref, provider: canonicalProvider };
    },
  };
}

export function canonicalizeModelCatalogProviderAlias(
  provider: string,
  params: ProviderAliasSource,
): string {
  return createModelCatalogProviderAliasCanonicalizer(params).provider(provider);
}

export function canonicalizeModelCatalogProviderRef<TRef extends { provider: string }>(
  ref: TRef,
  params: ProviderAliasSource,
): TRef {
  return createModelCatalogProviderAliasCanonicalizer(params).ref(ref);
}
