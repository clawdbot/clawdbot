import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";

export type LoadChannelOutboundAdapter = (
  id: ChannelId,
) => Promise<ChannelOutboundAdapter | undefined>;
