import { getLoadedChannelPlugin } from "./plugins/index.js";
import type { ChannelThreadingAdapter } from "./plugins/types.core.js";

/** Returns the loaded channel's threading adapter without bundled fallback discovery. */
export function getLoadedChannelThreadingAdapter(
  channel?: string | null,
): ChannelThreadingAdapter | undefined {
  if (!channel) {
    return undefined;
  }
  return getLoadedChannelPlugin(channel)?.threading;
}

/** Resolves where a loaded channel transport keeps thread identity. */
export function resolveChannelThreadAddressing(channel?: string | null): "address" | "message" {
  return getLoadedChannelThreadingAdapter(channel)?.threadAddressing ?? "address";
}

// Thread-addressed delivery must be declared, not inferred: a route can carry a
// threadId the transport cannot address, and posting through it would land at the
// conversation root instead of the thread. Unloaded/unknown channels stay false.
export function channelSupportsThreadDelivery(channel?: string | null): boolean {
  if (!channel) {
    return false;
  }
  return getLoadedChannelPlugin(channel)?.capabilities.threads === true;
}
