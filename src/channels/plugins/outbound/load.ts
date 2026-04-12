import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { LoadChannelOutboundAdapter } from "./load.types.js";

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// setup, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.
const loadOutboundAdapterFromRegistry = createChannelRegistryLoader<ChannelOutboundAdapter>(
  (entry) => entry.plugin.outbound,
);

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  return loadOutboundAdapterFromRegistry(id);
}

export type { LoadChannelOutboundAdapter };
