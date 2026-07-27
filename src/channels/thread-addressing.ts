import { getLoadedChannelPlugin } from "./plugins/index.js";

/** Resolves where a loaded channel transport keeps thread identity. */
export function resolveChannelThreadAddressing(channel?: string | null): "address" | "message" {
  if (!channel) {
    return "address";
  }
  return getLoadedChannelPlugin(channel)?.threading?.threadAddressing ?? "address";
}
