import type { PluginPackageChannel } from "../plugins/package-manifest.types.js";

export type BundledChannelCatalogEntry = {
  id: string;
  channel: PluginPackageChannel;
  aliases: readonly string[];
  order: number;
};
