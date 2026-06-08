// Delivery context helpers normalize target and route metadata for delivery.
import {
  formatGenericConversationTarget,
  type ConversationTargetParams,
} from "./conversation-target.js";
export {
  channelRouteFromDeliveryContext,
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "./delivery-context.shared.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

/** Formats a conversation id into a generic deliverable target. */
export function formatConversationTarget(params: ConversationTargetParams): string | undefined {
  return formatGenericConversationTarget(params);
}

/** Resolves a channel conversation into generic target fields for delivery routing. */
export function resolveConversationDeliveryTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): { to?: string; threadId?: string } {
  const to = formatConversationTarget(params);
  return { to };
}
