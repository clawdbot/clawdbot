import {
  channelRouteCompactKey,
  channelRouteThreadId,
  channelRouteTarget,
  normalizeChannelRouteRef,
  normalizeChannelRouteTarget,
  type ChannelRouteRef,
} from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "./account-id.js";
import type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
import { normalizeMessageChannel } from "./message-channel-core.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }
  const route = normalizeChannelRouteTarget({
    channel:
      typeof context.channel === "string"
        ? (normalizeMessageChannel(context.channel) ?? context.channel.trim())
        : undefined,
    to: context.to,
    accountId: context.accountId,
    threadId: context.threadId,
  });
  if (!route) {
    return undefined;
  }
  const normalized: DeliveryContext = {
    channel: route.channel,
    to: channelRouteTarget(route),
    accountId: normalizeAccountId(route.accountId),
  };
  const threadId = channelRouteThreadId(route);
  if (threadId != null) {
    normalized.threadId = threadId;
  }
  return normalized;
}

export function normalizeDeliveryChannelRoute(route?: unknown): ChannelRouteRef | undefined {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return undefined;
  }
  const candidate = route as ChannelRouteRef;
  return normalizeChannelRouteRef({
    channel: candidate.channel,
    to: candidate.target?.to,
    rawTo: candidate.target?.rawTo,
    chatType: candidate.target?.chatType,
    accountId: candidate.accountId,
    threadId: candidate.thread?.id,
    threadKind: candidate.thread?.kind,
    threadSource: candidate.thread?.source,
  });
}

export function deliveryContextFromChannelRoute(
  route?: ChannelRouteRef,
): DeliveryContext | undefined {
  const normalized = normalizeDeliveryChannelRoute(route);
  return normalizeDeliveryContext({
    channel: normalized?.channel,
    to: channelRouteTarget(normalized),
    accountId: normalized?.accountId,
    threadId: channelRouteThreadId(normalized),
  });
}

export function channelRouteFromDeliveryContext(
  context?: DeliveryContext,
): ChannelRouteRef | undefined {
  return normalizeChannelRouteTarget(normalizeDeliveryContext(context));
}

function mergeRouteMetadataWithDeliveryContext(
  route: ChannelRouteRef | undefined,
  context: DeliveryContext,
): ChannelRouteRef | undefined {
  if (!route) {
    return channelRouteFromDeliveryContext(context);
  }
  return normalizeChannelRouteRef({
    channel: route.channel ?? context.channel,
    to: route.target?.to ?? context.to,
    rawTo: route.target?.rawTo,
    chatType: route.target?.chatType,
    accountId: route.accountId ?? context.accountId,
    threadId: route.thread?.id ?? context.threadId,
    threadKind: route.thread?.kind,
    threadSource: route.thread?.source,
  });
}

export function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
} {
  if (!source) {
    return {
      route: undefined,
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  const normalizedRoute = normalizeDeliveryChannelRoute(source.route);
  const routeContext = deliveryContextFromChannelRoute(normalizedRoute);
  const legacyContext = normalizeDeliveryContext({
    channel: source.lastChannel ?? source.channel,
    to: source.lastTo,
    accountId: source.lastAccountId,
    threadId: source.lastThreadId,
  });
  const merged = mergeDeliveryContext(
    routeContext,
    mergeDeliveryContext(legacyContext, normalizeDeliveryContext(source.deliveryContext)),
  );

  if (!merged) {
    return {
      route: undefined,
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  return {
    route: mergeRouteMetadataWithDeliveryContext(normalizedRoute, merged),
    deliveryContext: merged,
    lastChannel: merged.channel,
    lastTo: merged.to,
    lastAccountId: merged.accountId,
    lastThreadId: merged.threadId,
  };
}

export function deliveryContextFromSession(
  entry?: DeliveryContextSessionSource,
): DeliveryContext | undefined {
  if (!entry) {
    return undefined;
  }
  const source: DeliveryContextSessionSource = {
    route: entry.route,
    channel: entry.channel ?? entry.origin?.provider,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId ?? entry.origin?.accountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    origin: entry.origin,
    deliveryContext: entry.deliveryContext,
  };
  return normalizeSessionDeliveryFields(source).deliveryContext;
}

export function mergeDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (!normalizedPrimary && !normalizedFallback) {
    return undefined;
  }
  const channelsConflict =
    normalizedPrimary?.channel &&
    normalizedFallback?.channel &&
    normalizedPrimary.channel !== normalizedFallback.channel;
  return normalizeDeliveryContext({
    channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
    // Keep route fields paired to their channel; avoid crossing fields between
    // unrelated channels during session context merges.
    to: channelsConflict
      ? normalizedPrimary?.to
      : (normalizedPrimary?.to ?? normalizedFallback?.to),
    accountId: channelsConflict
      ? normalizedPrimary?.accountId
      : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
    threadId: channelsConflict
      ? normalizedPrimary?.threadId
      : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
  });
}

export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  return channelRouteCompactKey(normalizeDeliveryContext(context));
}
