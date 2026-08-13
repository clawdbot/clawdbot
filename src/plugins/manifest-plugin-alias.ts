// Maps manifest-declared aliases (channels, providers, legacy ids) back to the owning plugin id.
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

export function normalizePluginAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return value ? Object.keys(value) : [];
}

function listManifestPluginAliases(plugin: PluginManifestRecord): readonly string[] {
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

/**
 * Fills `aliases` with every manifest-declared alias for each plugin in the registry. It mutates a
 * caller-supplied map rather than returning one so a caller that pre-seeds other identifiers keeps
 * its own entries: an alias is only claimed when the key is still free, and that check has to see
 * the pre-seeded keys. `createPluginRegistryIdNormalizer` seeds installed-index ids this way.
 */
export function collectManifestPluginAliases(
  registry: PluginManifestRegistry,
  aliases: Map<string, string>,
): void {
  for (const plugin of [...registry.plugins].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginAliasKey(pluginId), plugin.id);
    for (const alias of listManifestPluginAliases(plugin)) {
      const aliasKey = normalizePluginAliasKey(alias);
      if (alias.trim() && !aliases.has(aliasKey)) {
        aliases.set(aliasKey, pluginId);
      }
    }
  }
}

/**
 * Resolves an operator-written plugin id to the plugin that owns it, using manifest metadata only.
 * Config policy lists accept any of a plugin's aliases, and Gateway startup canonicalizes them
 * through the registry before applying `plugins.deny`/`plugins.entries`. Cold config paths that
 * hold a manifest registry but no installed index use this to reach the same canonical id.
 */
export function createManifestPluginAliasResolver(
  registry: PluginManifestRegistry,
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  collectManifestPluginAliases(registry, aliases);
  return (pluginId: string) => {
    const trimmed = pluginId.trim();
    return aliases.get(normalizePluginAliasKey(trimmed)) ?? trimmed;
  };
}
