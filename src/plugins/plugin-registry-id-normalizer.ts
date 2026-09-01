// Normalizes plugin registry identifiers from installed index records.
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

/** Inputs used to resolve aliases for installed plugin ids. */
export type PluginRegistryIdNormalizerOptions = {
  manifestRegistry?: PluginManifestRegistry;
  lookUpTable?: Pick<{ manifestRegistry: PluginManifestRegistry }, "manifestRegistry">;
};

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return value ? Object.keys(value) : [];
}

function listPluginRegistryNormalizerAliases(plugin: PluginManifestRecord): readonly string[] {
  return [
    plugin.id,
    ...(plugin.providers ?? []),
    ...(plugin.channels ?? []),
    ...(plugin.setup?.providers?.map((provider) => provider.id) ?? []),
    ...(plugin.cliBackends ?? []),
    ...(plugin.setup?.cliBackends ?? []),
    ...collectObjectKeys(plugin.modelCatalog?.providers),
    ...collectObjectKeys(plugin.modelCatalog?.aliases),
    ...collectObjectKeys(plugin.providerAuthAliases),
    ...(plugin.legacyPluginIds ?? []),
  ];
}

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
      aliases.set(pluginId.toLowerCase(), plugin.pluginId);
    }
  }
  const registry =
    options.lookUpTable?.manifestRegistry ??
    options.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index,
      includeDisabled: true,
    });
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      continue;
    }
    aliases.set(pluginId.toLowerCase(), plugin.id);
    for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
      const normalizedAlias = alias.trim();
      const normalizedAliasKey = normalizedAlias.toLowerCase();
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = pluginId.trim();
    return aliases.get(trimmed.toLowerCase()) ?? trimmed;
  };
}
