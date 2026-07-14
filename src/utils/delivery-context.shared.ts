// Shared delivery context helpers expose route normalization shared by modules.
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
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "./message-channel-constants.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "./message-channel-core.js";
export type { DeliveryContext } from "./delivery-context.types.js";

/**
 * Delivery-context normalization and projection helpers.
 *
 * Sessions still carry route metadata plus older `last*` fields; this module
 * keeps those shapes converged on the canonical SDK channel-route contract.
 */

/** Normalizes a delivery context into canonical channel route fields, dropping invalid routes. */
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

/** Normalizes an unknown channel route payload from persisted session/plugin metadata. */
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

/** Converts a normalized channel route reference into a delivery context. */
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

/** Converts delivery context fields into the SDK channel route reference shape. */
function channelRouteFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined {
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

function isInternalRouteContext(context?: DeliveryContext): boolean {
  const channel = context?.channel;
  return Boolean(
    channel && (channel === INTERNAL_MESSAGE_CHANNEL || isInternalNonDeliveryChannel(channel)),
  );
}

function hasExternalDeliveryTarget(context?: DeliveryContext): boolean {
  const channel = normalizeMessageChannel(context?.channel);
  return Boolean(
    channel &&
    !isInternalNonDeliveryChannel(channel) &&
    isDeliverableMessageChannel(channel) &&
    context?.to,
  );
}

function mergeExternalDeliveryContextOverInternalRoute(
  deliveryContext?: DeliveryContext,
  internalContext?: DeliveryContext,
): DeliveryContext | undefined {
  // Internal webchat/heartbeat routes are session plumbing. When a real channel
  // target is also present, preserve internal account/thread hints but let the
  // external channel/to pair own delivery.
  return normalizeDeliveryContext({
    channel: deliveryContext?.channel,
    to: deliveryContext?.to,
    accountId: deliveryContext?.accountId ?? internalContext?.accountId,
    threadId: deliveryContext?.threadId ?? internalContext?.threadId,
  });
}

/** Reconciles legacy session delivery fields, route metadata, and explicit delivery context. */
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
  const deliveryContext = normalizeDeliveryContext(source.deliveryContext);
  // Legacy webchat `last*` fields can outlive the external channel that should
  // receive replies. Prefer an explicit deliverable context when it exists.
  const sessionContext =
    isInternalRouteContext(legacyContext) && hasExternalDeliveryTarget(deliveryContext)
      ? mergeExternalDeliveryContextOverInternalRoute(deliveryContext, legacyContext)
      : mergeDeliveryContext(legacyContext, deliveryContext);
  const routeInternalContext = mergeDeliveryContext(routeContext, legacyContext);
  // Route metadata normally wins, except for internal fallback routes paired
  // with an explicit external delivery target from newer session state.
  const routeIsInternalFallback =
    isInternalRouteContext(routeContext) && hasExternalDeliveryTarget(deliveryContext);
  const merged = routeIsInternalFallback
    ? mergeExternalDeliveryContextOverInternalRoute(deliveryContext, routeInternalContext)
    : mergeDeliveryContext(routeContext, sessionContext);

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
    route: mergeRouteMetadataWithDeliveryContext(
      routeIsInternalFallback ? undefined : normalizedRoute,
      merged,
    ),
    deliveryContext: merged,
    lastChannel: merged.channel,
    lastTo: merged.to,
    lastAccountId: merged.accountId,
    lastThreadId: merged.threadId,
  };
}

/** Derives the best delivery context from current and legacy session fields. */
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

/** Merges delivery contexts without mixing target/account/thread fields across route owners. */
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
  const accountsConflict =
    normalizedPrimary?.accountId &&
    normalizedFallback?.accountId &&
    normalizedPrimary.accountId !== normalizedFallback.accountId;
  const routesConflict = channelsConflict || accountsConflict;
  return normalizeDeliveryContext({
    channel: accountsConflict
      ? normalizedPrimary?.channel
      : (normalizedPrimary?.channel ?? normalizedFallback?.channel),
    // Keep route fields paired to their channel account; crossing either owner
    // can address one account's target through another account's credentials.
    to: routesConflict ? normalizedPrimary?.to : (normalizedPrimary?.to ?? normalizedFallback?.to),
    accountId: routesConflict
      ? normalizedPrimary?.accountId
      : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
    threadId: routesConflict
      ? normalizedPrimary?.threadId
      : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
  });
}

/** Builds a compact stable key for a routable delivery context. */
export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  return channelRouteCompactKey(normalizeDeliveryContext(context));
}
