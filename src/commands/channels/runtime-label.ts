// Runtime-aware channel label lookup for command output.
import { getBundledChannelSetupPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChatChannel } from "./shared.js";

/** Resolve a display label from loaded, setup-only, or bundled channel plugin metadata. */
export const channelLabel = (channel: ChatChannel) => {
  const plugin =
    getLoadedChannelPlugin(channel) ??
    getBundledChannelSetupPlugin(channel) ??
    getChannelPlugin(channel);
  return plugin?.meta.label ?? channel;
};
