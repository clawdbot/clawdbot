import type { PluginManifestRecord } from "./manifest-registry.types.js";

export const PLUGIN_METADATA_CONTRIBUTION_KEYS = [
  "channels",
  "channelConfigs",
  "providers",
  "modelCatalogProviders",
  "cliBackends",
  "setupProviders",
  "commandAliases",
  "contracts",
] as const;

export type PluginMetadataContributionKey = (typeof PLUGIN_METADATA_CONTRIBUTION_KEYS)[number];

/** Raw declarations retain their order and spelling; owner indexes add normalization and aliases. */
export function listPluginManifestContributionIds(
  plugin: PluginManifestRecord,
  contribution: PluginMetadataContributionKey,
): readonly string[] {
  // Retain snapshot projection defaults when contribution arrays are omitted.
  switch (contribution) {
    case "providers":
      return plugin.providers ?? [];
    case "channels":
      return plugin.channels ?? [];
    case "channelConfigs":
      return Object.keys(plugin.channelConfigs ?? {});
    case "setupProviders":
      return plugin.setup?.providers?.map((provider) => provider.id) ?? [];
    case "cliBackends":
      return [...(plugin.cliBackends ?? []), ...(plugin.setup?.cliBackends ?? [])];
    case "modelCatalogProviders":
      return [
        ...Object.keys(plugin.modelCatalog?.providers ?? {}),
        ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
      ];
    case "commandAliases":
      return plugin.commandAliases?.map((alias) => alias.name) ?? [];
    case "contracts":
      return Object.entries(plugin.contracts ?? {}).flatMap(([key, values]) =>
        Array.isArray(values) && values.length > 0 ? [key] : [],
      );
  }
  return [];
}
