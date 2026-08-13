// Normalizes plugin registry identifiers from installed index records.
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { collectManifestPluginAliases, normalizePluginAliasKey } from "./manifest-plugin-alias.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";

/** Inputs used to resolve aliases for installed plugin ids. */
export type PluginRegistryIdNormalizerOptions = {
  manifestRegistry?: PluginManifestRegistry;
  lookUpTable?: Pick<{ manifestRegistry: PluginManifestRegistry }, "manifestRegistry">;
};

/** Creates a normalizer that maps provider/channel/catalog aliases back to plugin ids. */
export function createPluginRegistryIdNormalizer(
  index: InstalledPluginIndex,
  options: PluginRegistryIdNormalizerOptions = {},
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    if (!plugin.pluginId) {
      continue;
    }
    const pluginId = plugin.pluginId.trim();
    if (pluginId) {
      aliases.set(normalizePluginAliasKey(pluginId), plugin.pluginId);
    }
  }
  const registry =
    options.lookUpTable?.manifestRegistry ??
    options.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index,
      includeDisabled: true,
    });
  collectManifestPluginAliases(registry, aliases);
  return (pluginId: string) => {
    const trimmed = pluginId.trim();
    return aliases.get(normalizePluginAliasKey(trimmed)) ?? trimmed;
  };
}
