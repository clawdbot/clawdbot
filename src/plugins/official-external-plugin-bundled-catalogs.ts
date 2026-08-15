// Generated bundled catalogs shared by full catalog loading and startup projections.
import channelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import pluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import providerCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };

export const BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOGS = [
  channelCatalog,
  providerCatalog,
  pluginCatalog,
] as const;

export const BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES: readonly unknown[] = [
  ...channelCatalog.entries,
  ...providerCatalog.entries,
  ...pluginCatalog.entries,
];
