// Channel setup test helpers build channel metadata and prompt fixtures.
type ChannelMeta = import("../channels/plugins/types.core.js").ChannelMeta;
type ChannelPluginCatalogEntry = import("../channels/plugins/catalog.js").ChannelPluginCatalogEntry;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;

// Small builders for channel setup tests; mirror discovery shapes without loading real plugins.
type ChannelSetupEntries = ReturnType<ResolveChannelSetupEntries>;

/** Builds channel metadata with the defaults most setup tests need. */
export function makeMeta(
  id: string,
  label: string,
  overrides: Partial<ChannelMeta> = {},
): ChannelMeta {
  return {
    id: id as ChannelMeta["id"],
    label,
    selectionLabel: overrides.selectionLabel ?? label,
    docsPath: overrides.docsPath ?? `/channels/${id}`,
    blurb: overrides.blurb ?? "",
    ...overrides,
  };
}

/** Builds a catalog entry for an installable or installed channel plugin. */
export function makeCatalogEntry(
  id: string,
  label: string,
  overrides: Partial<ChannelPluginCatalogEntry> = {},
): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: overrides.pluginId ?? id,
    meta: makeMeta(id, label, overrides.meta),
    install: overrides.install ?? { npmSpec: `@openclaw/${id}` },
    ...overrides,
  };
}

/** Builds the full discovery result shape used by channel setup flows. */
export function makeChannelSetupEntries(
  overrides: Partial<ChannelSetupEntries> = {},
): ChannelSetupEntries {
  return {
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
    ...overrides,
  };
}
