/**
 * Lazy channel outbound adapter loader.
 *
 * Loads only outbound send primitives from the channel registry for cheap delivery paths.
 */
import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { LoadChannelOutboundAdapter } from "./load.types.js";

const loadOutboundAdapterFromRegistry = createChannelRegistryLoader<ChannelOutboundAdapter>(
  (entry) => entry.plugin.outbound,
);

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  return loadOutboundAdapterFromRegistry(id);
}

export type { LoadChannelOutboundAdapter };
