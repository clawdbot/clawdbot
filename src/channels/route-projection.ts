// Route projection helpers between sessions, delivery context, and channel routes.
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { normalizeChannelRouteRef, type ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import {
  normalizeConversationTargetParams,
  type ConversationTargetParams,
} from "../utils/conversation-target.js";
import {
  deliveryContextFromChannelRoute,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { getChannelPlugin, normalizeChannelId } from "./plugins/registry.js";

/** Formats a conversation id into a deliverable target, using channel hooks before generic fallback. */
export function formatConversationTarget(params: ConversationTargetParams): string | undefined {
  const { channel, conversationId, parentConversationId } =
    normalizeConversationTargetParams(params);
  if (!channel || !conversationId) {
    return undefined;
  }
  const normalizedChannel = normalizeChannelId(channel);
  const pluginTarget = normalizedChannel
    ? getChannelPlugin(normalizedChannel)?.messaging?.resolveDeliveryTarget?.({
        conversationId,
        parentConversationId,
      })
    : null;
  if (pluginTarget?.to?.trim()) {
    return pluginTarget.to.trim();
  }
  return `channel:${conversationId}`;
}

/** Resolves a channel conversation into target/thread fields for delivery routing. */
function resolveConversationDeliveryTarget(params: ConversationTargetParams): {
  to?: string;
  threadId?: string;
} {
  const { channel, conversationId, parentConversationId } =
    normalizeConversationTargetParams(params);
  const pluginTarget =
    channel && conversationId
      ? getChannelPlugin(
          normalizeChannelId(channel) ?? channel,
        )?.messaging?.resolveDeliveryTarget?.({
          conversationId,
          parentConversationId,
        })
      : null;
  if (pluginTarget) {
    return {
      ...(pluginTarget.to?.trim() ? { to: pluginTarget.to.trim() } : {}),
      ...(pluginTarget.threadId?.trim() ? { threadId: pluginTarget.threadId.trim() } : {}),
    };
  }
  const to = formatConversationTarget(params);
  return { to };
}

/** Converts a persisted conversation reference into a channel route. */
export function routeFromConversationRef(
  conversation?: ConversationRef | null,
): ChannelRouteRef | undefined {
  if (!conversation) {
    return undefined;
  }
  const target = resolveConversationDeliveryTarget({
    channel: conversation.channel,
    conversationId: conversation.conversationId,
    parentConversationId: conversation.parentConversationId,
  });
  return normalizeChannelRouteRef({
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: target.to,
    threadId: target.threadId,
    threadSource: target.threadId ? "target" : undefined,
  });
}

/** Extracts a channel route from a session binding record. */
export function routeFromBindingRecord(
  binding?: SessionBindingRecord | null,
): ChannelRouteRef | undefined {
  return routeFromConversationRef(binding?.conversation);
}

/** Projects route fields used by older session and delivery callers. */
export function routeToDeliveryFields(route?: ChannelRouteRef): {
  deliveryContext?: DeliveryContext;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const deliveryContext = deliveryContextFromChannelRoute(route);
  return {
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(deliveryContext?.channel ? { channel: deliveryContext.channel } : {}),
    ...(deliveryContext?.to ? { to: deliveryContext.to } : {}),
    ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
    ...(deliveryContext?.threadId != null ? { threadId: deliveryContext.threadId } : {}),
  };
}
