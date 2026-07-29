import type { SessionOrigin } from "../../config/sessions.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { normalizeDeliveryChannelRoute } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export function stripThreadFromSessionRoute(
  route: ChannelRouteRef | undefined,
): ChannelRouteRef | undefined {
  const normalized = normalizeDeliveryChannelRoute(route);
  if (!normalized?.thread) {
    return normalized;
  }
  const { thread: _drop, ...withoutThread } = normalized;
  return Object.keys(withoutThread).length > 0 ? withoutThread : undefined;
}

export function stripThreadIdFromDeliveryContext(
  context: DeliveryContext | undefined,
): DeliveryContext | undefined {
  if (!context || context.threadId == null || context.threadId === "") {
    return context;
  }
  const { threadId: _threadId, ...rest } = context;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function stripThreadIdFromOrigin(
  origin: SessionOrigin | undefined,
): SessionOrigin | undefined {
  if (!origin || origin.threadId == null || origin.threadId === "") {
    return origin;
  }
  const { threadId: _threadId, ...rest } = origin;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
