import { resolveRouteTargetForLoadedChannel } from "../channels/plugins/target-parsing-loaded.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type {
  DeliveryContext,
  DeliveryContextSessionSource,
} from "../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
export type { DeliveryContext } from "../utils/delivery-context.types.js";

function stripThreadRouteSuffix(target: string): string {
  return /^(.*):topic:[^:]+$/u.exec(target)?.[1] ?? target;
}

function normalizeAnnounceRouteTarget(context?: DeliveryContext): string | undefined {
  const rawTo = normalizeOptionalString(context?.to);
  if (!rawTo) {
    return undefined;
  }
  const channel = normalizeOptionalString(context?.channel);
  const parsed = channel
    ? resolveRouteTargetForLoadedChannel({
        channel,
        rawTarget: rawTo,
        fallbackThreadId: context?.threadId,
      })
    : null;
  let route = stripThreadRouteSuffix(parsed?.to ?? rawTo);
  if (channel && route.toLowerCase().startsWith(`${channel}:`)) {
    route = route.slice(channel.length + 1);
  }
  if (route.startsWith("group:") || route.startsWith("channel:")) {
    route = route.slice(route.indexOf(":") + 1);
  }
  return route || undefined;
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
  const requesterTarget = normalizeAnnounceRouteTarget(normalizedRequester);
  const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry);
  if (requesterTarget && entryTarget) {
    return requesterTarget !== entryTarget;
  }
  return false;
}

export function resolveAnnounceOrigin(
  entry?: DeliveryContextSessionSource,
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
