type ChannelMeta = import("../channels/plugins/types.core.js").ChannelMeta;
type ChannelPluginCatalogEntry = import("../channels/plugins/catalog.js").ChannelPluginCatalogEntry;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;

type ChannelSetupEntries = ReturnType<ResolveChannelSetupEntries>;

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
