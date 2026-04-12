import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "../shared/string-coerce.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";

export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type DeliveryContextSource = {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  deliveryContext?: DeliveryContext;
};

function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }
  const normalized: DeliveryContext = {
    channel: normalizeOptionalLowercaseString(context.channel),
    to: normalizeOptionalString(context.to),
    accountId: normalizeOptionalString(context.accountId),
  };
  const threadId = normalizeOptionalThreadValue(context.threadId);
  if (threadId != null) {
    normalized.threadId = threadId;
  }
  if (
    !normalized.channel &&
    !normalized.to &&
    !normalized.accountId &&
    normalized.threadId == null
  ) {
    return undefined;
  }
  return normalized;
}

function mergeDeliveryContext(
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

function deliveryContextFromSession(entry?: DeliveryContextSource): DeliveryContext | undefined {
  if (!entry) {
    return undefined;
  }
  return normalizeDeliveryContext({
    channel:
      entry.deliveryContext?.channel ??
      entry.lastChannel ??
      entry.channel ??
      entry.origin?.provider,
    to: entry.deliveryContext?.to ?? entry.lastTo,
    accountId: entry.deliveryContext?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
    threadId: entry.deliveryContext?.threadId ?? entry.lastThreadId ?? entry.origin?.threadId,
  });
}

function normalizeTelegramAnnounceTarget(target: string | undefined): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("group:")) {
    return `telegram:${trimmed.slice("group:".length)}`;
  }
  if (!trimmed.startsWith("telegram:")) {
    return undefined;
  }
  const raw = trimmed.slice("telegram:".length);
  const topicMatch = /^(.*):topic:[^:]+$/u.exec(raw);
  return `telegram:${topicMatch?.[1] ?? raw}`;
}

function shouldStripThreadFromAnnounceEntry(
  normalizedRequester?: DeliveryContext,
  normalizedEntry?: DeliveryContext,
): boolean {
  if (
    !normalizedRequester?.to ||
    normalizedRequester.threadId != null ||
    normalizedEntry?.threadId == null
  ) {
    return false;
  }
  const requesterChannel = normalizeOptionalLowercaseString(normalizedRequester.channel);
  if (requesterChannel === "telegram") {
    const requesterTarget = normalizeTelegramAnnounceTarget(normalizedRequester.to);
    const entryTarget = normalizeTelegramAnnounceTarget(normalizedEntry?.to);
    if (requesterTarget && entryTarget) {
      return requesterTarget !== entryTarget;
    }
  }
  const requesterTarget = normalizeOptionalString(normalizedRequester.to);
  const entryTarget = normalizeOptionalString(normalizedEntry?.to);
  if (requesterTarget && entryTarget) {
    return requesterTarget !== entryTarget;
  }
  return false;
}

export function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  const entryForMerge =
    normalizedEntry && shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry)
      ? (() => {
          const { threadId: _ignore, ...rest } = normalizedEntry;
          return rest;
        })()
      : normalizedEntry;
  return mergeDeliveryContext(normalizedRequester, entryForMerge);
}
