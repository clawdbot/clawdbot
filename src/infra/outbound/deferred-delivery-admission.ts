// Resolves provider-owned admission before outbound intents are persisted or replayed.
import type {
  ChannelMessageDeferredDeliveryAdmissionContext,
  ChannelMessageDeferredDeliveryAdmissionResult,
} from "../../channels/message/types.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";

export function resolveDeferredDeliveryAdmission(
  params: ChannelMessageDeferredDeliveryAdmissionContext,
  owner?: { agentId?: string },
): ChannelMessageDeferredDeliveryAdmissionResult {
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: params.channel,
    cfg: params.cfg,
    agentId: owner?.agentId,
    allowBootstrap: true,
  });
  return adapter?.durableFinal?.admitDeferredDelivery?.(params) ?? { status: "allowed" };
}
