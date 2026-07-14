import type { SessionEntry } from "../../config/sessions.js";
import { normalizeDeliveryChannelRoute } from "../../utils/delivery-context.shared.js";

export function stripThreadFromSessionRoute(route: SessionEntry["route"]): SessionEntry["route"] {
  const normalized = normalizeDeliveryChannelRoute(route);
  if (!normalized?.thread) {
    return normalized;
  }
  const { thread: _drop, ...withoutThread } = normalized;
  return Object.keys(withoutThread).length > 0 ? withoutThread : undefined;
}

export function stripThreadIdFromDeliveryContext(
  context: SessionEntry["deliveryContext"],
): SessionEntry["deliveryContext"] {
  if (!context || context.threadId == null || context.threadId === "") {
    return context;
  }
  const { threadId: _threadId, ...rest } = context;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function stripThreadIdFromOrigin(origin: SessionEntry["origin"]): SessionEntry["origin"] {
  if (!origin || origin.threadId == null || origin.threadId === "") {
    return origin;
  }
  const { threadId: _threadId, ...rest } = origin;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
