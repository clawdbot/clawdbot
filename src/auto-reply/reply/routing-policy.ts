/** Resolves whether replies should route to the originating channel or current surface. */
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";

/** Computes source-routing and typing suppression for a reply turn. */
export function resolveReplyRoutingDecision(params: {
  provider?: string;
  surface?: string;
  explicitDeliverRoute?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  suppressDirectUserDelivery?: boolean;
  isRoutableChannel: (channel: string | undefined) => boolean;
}) {
  const originatingChannel = normalizeMessageChannel(params.originatingChannel);
  const providerChannel = normalizeMessageChannel(params.provider);
  const surfaceChannel = normalizeMessageChannel(params.surface);
  const currentSurface = providerChannel ?? surfaceChannel;
  const isInternalWebchatTurn =
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    params.explicitDeliverRoute !== true;
  const shouldRouteToOriginating = Boolean(
    !params.suppressDirectUserDelivery &&
    !isInternalWebchatTurn &&
    params.isRoutableChannel(originatingChannel) &&
    params.originatingTo &&
    originatingChannel !== currentSurface,
  );
  return {
    originatingChannel,
    currentSurface,
    isInternalWebchatTurn,
    shouldRouteToOriginating,
    shouldSuppressTyping:
      params.suppressDirectUserDelivery === true ||
      shouldRouteToOriginating ||
      originatingChannel === INTERNAL_MESSAGE_CHANNEL,
  };
}
