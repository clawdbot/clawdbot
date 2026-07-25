import type {
  SessionDeliveryState,
  SessionEntry,
  SessionOrigin,
} from "../config/sessions/types.js";
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
import type { DeliveryContext } from "./delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "./message-channel-constants.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "./message-channel-core.js";
export type { DeliveryContext } from "./delivery-context.types.js";

/**
 * Delivery-context normalization and projection helpers.
 *
 * Persisted sessions expose one closed delivery state. Compatibility
 * projections are derived from that state at public boundaries.
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

type SessionDeliveryProjection = {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

export function isCanonicalSessionDeliveryState(value: unknown): value is SessionDeliveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "none" || candidate.kind === "internal") {
    return true;
  }
  return (
    candidate.kind === "external" &&
    Boolean(candidate.route && typeof candidate.route === "object") &&
    Boolean(candidate.context && typeof candidate.context === "object") &&
    Boolean(candidate.origin && typeof candidate.origin === "object")
  );
}

/** Builds one canonical delivery state from current turn routing facts. */
export function normalizeSessionDeliveryState(params?: {
  route?: ChannelRouteRef;
  context?: DeliveryContext;
  origin?: SessionOrigin;
}): SessionDeliveryState {
  if (!params) {
    return { kind: "none" };
  }

  const normalizedRoute = normalizeDeliveryChannelRoute(params.route);
  const routeContext = deliveryContextFromChannelRoute(normalizedRoute);
  const originContext = normalizeDeliveryContext({
    channel: params.origin?.provider,
    to: params.origin?.to,
    accountId: params.origin?.accountId,
    threadId: params.origin?.threadId,
  });
  const context = normalizeDeliveryContext(params.context);
  const fallbackContext = mergeDeliveryContext(context, originContext);
  const routeIsInternalFallback =
    isInternalRouteContext(routeContext) && hasExternalDeliveryTarget(context);
  const merged = routeIsInternalFallback
    ? mergeExternalDeliveryContextOverInternalRoute(
        context,
        mergeDeliveryContext(routeContext, originContext),
      )
    : mergeDeliveryContext(routeContext, fallbackContext);

  if (!merged) {
    return { kind: "none" };
  }
  if (isInternalRouteContext(merged)) {
    return { kind: "internal" };
  }
  const route = mergeRouteMetadataWithDeliveryContext(
    routeIsInternalFallback ? undefined : normalizedRoute,
    merged,
  );
  if (!route) {
    return { kind: "none" };
  }
  const origin: SessionOrigin = { ...params.origin };
  origin.provider ??= merged.channel;
  origin.to ??= merged.to;
  origin.accountId ??= merged.accountId;
  origin.threadId ??= merged.threadId;
  origin.chatType ??= route.target?.chatType;
  return { kind: "external", route, context: merged, origin };
}

/** Projects compatibility fields without persisting duplicate delivery state. */
export function projectSessionDeliveryFields(
  delivery?: SessionDeliveryState,
): SessionDeliveryProjection {
  if (delivery?.kind !== "external") {
    return {};
  }
  return {
    route: delivery.route,
    deliveryContext: delivery.context,
    origin: delivery.origin,
    channel: delivery.context.channel ?? delivery.origin.provider,
    lastChannel: delivery.context.channel,
    lastTo: delivery.context.to,
    lastAccountId: delivery.context.accountId,
    lastThreadId: delivery.context.threadId,
  };
}

/** Reads only the canonical persisted delivery record. */
export function deliveryContextFromSession(
  entry?: Pick<SessionEntry, "delivery">,
): DeliveryContext | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.context : undefined;
}

export function sessionDeliveryRoute(
  entry?: Pick<SessionEntry, "delivery">,
): ChannelRouteRef | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.route : undefined;
}

export function sessionDeliveryOrigin(
  entry?: Pick<SessionEntry, "delivery">,
): SessionOrigin | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.origin : undefined;
}

export function sessionDeliveryChannel(entry?: Pick<SessionEntry, "delivery">): string | undefined {
  const delivery = entry?.delivery;
  return delivery?.kind === "external"
    ? (delivery.context.channel ?? delivery.origin.provider)
    : undefined;
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
