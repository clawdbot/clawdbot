import { listBundledChannelPluginIds as listCatalogBundledChannelPluginIds } from "../../../src/channels/plugins/bundled-ids.js";
import type { ChannelId } from "../../../src/channels/plugins/channel-id.types.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import {
  listChannelCatalogEntries,
  type PluginChannelCatalogEntry,
} from "../../../src/plugins/channel-catalog-registry.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type ChannelPluginApiModule = Record<string, unknown>;

const channelPluginCache = new Map<ChannelId, ChannelPlugin | null>();
let channelCatalogEntries: PluginChannelCatalogEntry[] | undefined;

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
  );
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listCatalogBundledChannelPluginIds() as ChannelId[];
}

export function getBundledChannelCatalogEntry(
  id: ChannelId,
): PluginChannelCatalogEntry | undefined {
  channelCatalogEntries ??= listChannelCatalogEntries({ origin: "bundled" });
  return channelCatalogEntries.find((entry) => entry.pluginId === id || entry.channel.id === id);
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  if (channelPluginCache.has(id)) {
    return channelPluginCache.get(id) ?? undefined;
  }

  const loaded = loadBundledPluginPublicSurfaceSync<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  });
  const plugin = Object.values(loaded).find(isChannelPlugin) ?? null;
  channelPluginCache.set(id, plugin);
  return plugin ?? undefined;
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  return listBundledChannelPluginIds().flatMap((id) => {
    const plugin = getBundledChannelPlugin(id);
    return plugin ? [plugin] : [];
  });
}
