import { listChannelCatalogEntries } from "./channel-catalog-registry.js";
import type { PluginPackageChannel } from "./manifest.js";

export function listBundledPackageChannelMetadata(): readonly PluginPackageChannel[] {
  return listChannelCatalogEntries({ origin: "bundled" }).map((entry) => entry.channel);
}

export function findBundledPackageChannelMetadata(
  channelId: string,
): PluginPackageChannel | undefined {
  return listBundledPackageChannelMetadata().find(
    (channel) => channel.id === channelId || channel.aliases?.includes(channelId),
  );
}
