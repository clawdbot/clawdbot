import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeAccountId } from "./account-id.js";
import type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
import { normalizeMessageChannel } from "./message-channel.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }
  const channel =
    typeof context.channel === "string"
      ? (normalizeMessageChannel(context.channel) ?? context.channel.trim())
      : undefined;
  const to = normalizeOptionalString(context.to);
  const accountId = normalizeAccountId(context.accountId);
  const threadId =
    typeof context.threadId === "number" && Number.isFinite(context.threadId)
      ? Math.trunc(context.threadId)
      : typeof context.threadId === "string"
        ? normalizeOptionalString(context.threadId)
        : undefined;
  const normalizedThreadId =
    typeof threadId === "string" ? (threadId ? threadId : undefined) : threadId;
  if (!channel && !to && !accountId && normalizedThreadId == null) {
    return undefined;
  }
  const normalized: DeliveryContext = {
    channel: channel || undefined,
    to: to || undefined,
    accountId,
  };
  if (normalizedThreadId != null) {
    normalized.threadId = normalizedThreadId;
  }
  return normalized;
}

export function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
} {
  if (!source) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  const merged = mergeDeliveryContext(
    normalizeDeliveryContext({
      channel: source.lastChannel ?? source.channel,
      to: source.lastTo,
      accountId: source.lastAccountId,
      threadId: source.lastThreadId,
    }),
    normalizeDeliveryContext(source.deliveryContext),
  );

  if (!merged) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    };
  }

  return {
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
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized?.to) {
    return undefined;
  }
  const threadId =
    normalized.threadId != null && normalized.threadId !== "" ? String(normalized.threadId) : "";
  return `${normalized.channel}|${normalized.to}|${normalized.accountId ?? ""}|${threadId}`;
}
