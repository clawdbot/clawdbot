import { loadBundledPluginPublicSurface } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { listBundledChannelPluginIds as listCatalogBundledChannelPluginIds } from "../../bundled-ids.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { ChannelPlugin } from "../../types.js";

type ChannelPluginApiModule = Record<string, unknown>;

const channelPluginCache = new Map<ChannelId, ChannelPlugin | null>();
const channelPluginPromiseCache = new Map<ChannelId, Promise<ChannelPlugin | null>>();

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

export async function getBundledChannelPluginAsync(
  id: ChannelId,
): Promise<ChannelPlugin | undefined> {
  if (channelPluginCache.has(id)) {
    return channelPluginCache.get(id) ?? undefined;
  }

  const cachedPromise = channelPluginPromiseCache.get(id);
  if (cachedPromise) {
    return (await cachedPromise) ?? undefined;
  }

  const loading = loadBundledPluginPublicSurface<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  })
    .then((loaded) => {
      const plugin = Object.values(loaded).find(isChannelPlugin) ?? null;
      channelPluginCache.set(id, plugin);
      return plugin;
    })
    .finally(() => {
      channelPluginPromiseCache.delete(id);
    });
  channelPluginPromiseCache.set(id, loading);
  return (await loading) ?? undefined;
}
