import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelCatalogProviderAliasTargets } from "../model-catalog/manifest-planner.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

/** Prepares provider aliases once for one captured catalog metadata generation. */
export function createPreparedModelCatalogProviderNormalizer(
  metadataSnapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">,
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): (provider: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of metadataSnapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: metadataSnapshot,
        plugin,
        config,
        env,
      })
    ) {
      continue;
    }
    for (const [target, providerAliases] of buildModelCatalogProviderAliasTargets(plugin)) {
      const canonicalProvider = normalizeProviderId(target);
      for (const alias of providerAliases) {
        const key = normalizeProviderId(alias);
        // Duplicate owned aliases retain the first target in manifest order.
        if (!aliases.has(key)) {
          aliases.set(key, canonicalProvider);
        }
      }
    }
  }
  return (provider) => {
    const normalizedProvider = normalizeProviderId(provider);
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
}
