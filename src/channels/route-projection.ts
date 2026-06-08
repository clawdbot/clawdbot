// Route projection helpers between sessions, delivery context, and channel routes.
import type { SessionEntry } from "../config/sessions/types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import {
  channelRouteThreadId,
  channelRouteTarget,
  normalizeChannelRouteRef,
  type ChannelRouteChatType,
  type ChannelRouteRef,
} from "../plugin-sdk/channel-route.js";
import {
  normalizeConversationTargetParams,
  type ConversationTargetParams,
} from "../utils/conversation-target.js";
import {
  channelRouteFromDeliveryContext,
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
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
export function resolveConversationDeliveryTarget(params: ConversationTargetParams): {
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

/** Channel route normalized enough to address an outbound delivery target. */
export type RoutableChannelRouteRef = ChannelRouteRef & {
  channel: string;
  target: {
    to: string;
    rawTo?: string;
    chatType?: ChannelRouteChatType;
  };
};

/** Session fields that can carry or reconstruct a channel route. */
export type SessionRouteDeliveryFields = {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

/** Normalizes a route and rejects routes that cannot address a channel target. */
export function normalizeRoutableChannelRoute(
  route?: ChannelRouteRef | null,
): RoutableChannelRouteRef | undefined {
  const normalized = normalizeChannelRouteRef({
    channel: route?.channel,
    accountId: route?.accountId,
    to: route?.target?.to,
    rawTo: route?.target?.rawTo,
    chatType: route?.target?.chatType,
    threadId: route?.thread?.id,
    threadKind: route?.thread?.kind,
    threadSource: route?.thread?.source,
  });
  if (!normalized?.channel || !normalized.target?.to) {
    return undefined;
  }
  return normalized as RoutableChannelRouteRef;
}

/** Converts legacy delivery context metadata into a channel route. */
export function routeFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined {
  return channelRouteFromDeliveryContext(normalizeDeliveryContext(context));
}

/** Converts a channel route back to legacy delivery context metadata. */
export function deliveryContextFromRoute(route?: ChannelRouteRef): DeliveryContext | undefined {
  return deliveryContextFromChannelRoute(route);
}

/** Projects the best known delivery route from a stored session entry. */
export function routeFromSessionEntry(entry?: SessionEntry | null): ChannelRouteRef | undefined {
  if (!entry) {
    return undefined;
  }
  return (
    normalizeSessionDeliveryFields(entry).route ??
    routeFromDeliveryContext(deliveryContextFromSession(entry))
  );
}

/** Builds session persistence fields from a channel route. */
export function sessionDeliveryFieldsFromRoute(
  route?: ChannelRouteRef,
): SessionRouteDeliveryFields {
  return normalizeSessionDeliveryFields({ route });
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

/** Converts a conversation reference into a routable channel route. */
export function routableRouteFromConversationRef(
  conversation?: ConversationRef | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromConversationRef(conversation));
}

/** Extracts a channel route from a session binding record. */
export function routeFromBindingRecord(
  binding?: SessionBindingRecord | null,
): ChannelRouteRef | undefined {
  return routeFromConversationRef(binding?.conversation);
}

/** Extracts a routable channel route from a session binding record. */
export function routableRouteFromBindingRecord(
  binding?: SessionBindingRecord | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromBindingRecord(binding));
}

/** Projects route fields used by older session and delivery callers. */
export function routeToDeliveryFields(route?: ChannelRouteRef): {
  deliveryContext?: DeliveryContext;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const deliveryContext = deliveryContextFromRoute(route);
  return {
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(deliveryContext?.channel ? { channel: deliveryContext.channel } : {}),
    ...(deliveryContext?.to ? { to: deliveryContext.to } : {}),
    ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
    ...(deliveryContext?.threadId != null ? { threadId: deliveryContext.threadId } : {}),
  };
}

/** Compares whether two routes address the same delivery target. */
export function routesShareDeliveryTarget(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean {
  const left = normalizeRoutableChannelRoute(params.left);
  const right = normalizeRoutableChannelRoute(params.right);
  if (!left || !right) {
    return false;
  }
  return (
    left.channel === right.channel &&
    channelRouteTarget(left) === channelRouteTarget(right) &&
    // Missing account ids are wildcards; thread ids must match when present.
    (left.accountId == null || right.accountId == null || left.accountId === right.accountId) &&
    String(channelRouteThreadId(left) ?? "") === String(channelRouteThreadId(right) ?? "")
  );
}
