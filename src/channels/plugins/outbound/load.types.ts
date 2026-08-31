/**
 * Lazy outbound adapter loader type.
 *
 * Describes the minimal async boundary used by channel delivery code.
 */
import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";

/**
 * Lazy loader contract for channel outbound adapters.
 */
export type LoadChannelOutboundAdapter = (
  id: ChannelId,
) => Promise<ChannelOutboundAdapter | undefined>;
