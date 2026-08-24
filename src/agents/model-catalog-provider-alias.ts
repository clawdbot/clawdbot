import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

function resolvePreparedModelCatalogProvider(
  provider: string,
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">,
  isIdentityAlias: (target: { api?: unknown; baseUrl?: unknown }) => boolean,
): string {
  const normalizedProvider = normalizeProviderId(provider);
  for (const plugin of metadataSnapshot.manifestRegistry.plugins) {
    for (const [alias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      if (normalizeProviderId(alias) === normalizedProvider && isIdentityAlias(target)) {
        const canonicalProvider = normalizeProviderId(target.provider);
        if (canonicalProvider) {
          return canonicalProvider;
        }
      }
    }
  }
  return normalizedProvider;
}

/** Runtime discovery follows identity aliases, not aliases that change the request route. */
export function canonicalizePreparedModelRuntimeDiscoveryProvider(
  provider: string,
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): string {
  return resolvePreparedModelCatalogProvider(
    provider,
    metadataSnapshot,
    (target) => target.api === undefined && target.baseUrl === undefined,
  );
}
