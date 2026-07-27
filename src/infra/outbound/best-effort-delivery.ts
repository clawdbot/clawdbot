// Best-effort delivery helpers normalize optional external destinations and
// decide when a reply should stay session-only.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

/** Optional external destination for best-effort delivery from session-only flows. */
export type ExternalBestEffortDeliveryTarget = {
  deliver: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

/** Normalizes an optional best-effort destination into a deliver/no-deliver decision. */
export function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string | null;
  to?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
}): ExternalBestEffortDeliveryTarget {
  const normalizedChannel = normalizeMessageChannel(params.channel);
  const channel =
    normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
      ? normalizedChannel
      : undefined;
  const to = normalizeOptionalString(params.to);
  const deliver = Boolean(channel && to);
  return {
    deliver,
    channel: deliver ? channel : undefined,
    to: deliver ? to : undefined,
    accountId: deliver ? normalizeOptionalString(params.accountId) : undefined,
    threadId:
      deliver && params.threadId != null && params.threadId !== ""
        ? stringifyRouteThreadId(params.threadId)
        : undefined,
  };
}

/** Detects best-effort sends that should stay session-only on the internal channel. */
export function shouldDowngradeDeliveryToSessionOnly(params: {
  wantsDelivery: boolean;
  bestEffortDeliver: boolean;
  resolvedChannel: string;
}): boolean {
  return (
    params.wantsDelivery &&
    params.bestEffortDeliver &&
    params.resolvedChannel === INTERNAL_MESSAGE_CHANNEL
  );
}
