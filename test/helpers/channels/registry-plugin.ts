import { listBundledChannelPlugins } from "../../../src/channels/plugins/bundled.js";
import { normalizeChannelMeta } from "../../../src/channels/plugins/meta-normalization.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

export function getPluginContractRegistry(): PluginContractEntry[] {
  return listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin: {
      ...plugin,
      meta: normalizeChannelMeta({ id: plugin.id, meta: plugin.meta }),
    },
  }));
}
