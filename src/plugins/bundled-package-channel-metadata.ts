// Collects bundled package channel metadata from plugin catalogs.
import { listChannelCatalogEntries } from "./channel-catalog-registry.js";
import type { PluginPackageChannel } from "./manifest.js";

/** Lists channel metadata contributed by bundled package manifests. */
export function listBundledPackageChannelMetadata(): readonly PluginPackageChannel[] {
  return listChannelCatalogEntries({ origin: "bundled" }).map((entry) => entry.channel);
}

/** Finds bundled package channel metadata by id or alias. */
export function findBundledPackageChannelMetadata(
  channelId: string,
): PluginPackageChannel | undefined {
  return listBundledPackageChannelMetadata().find(
    (channel) => channel.id === channelId || channel.aliases?.includes(channelId),
  );
}
