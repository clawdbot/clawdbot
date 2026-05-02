import {
  parseExplicitTargetForLoadedChannel,
  resolveRouteTargetForLoadedChannel,
} from "../../channels/plugins/target-parsing-loaded.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import { channelRouteTargetsShareConversation } from "../../plugin-sdk/channel-route.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel-core.js";
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel-normalize.js";
import { resolveTargetPrefixedChannel } from "./channel-target-prefix.js";

export type SessionDeliveryTarget = {
  channel?: DeliverableMessageChannel;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  /** Whether threadId came from an explicit source (config/param/:topic: parsing) vs session history. */
  threadIdExplicit?: boolean;
  mode: ChannelOutboundTargetMode;
  lastChannel?: DeliverableMessageChannel;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

function parseExplicitTargetWithPlugin(params: {
  channel?: DeliverableMessageChannel;
  fallbackChannel?: DeliverableMessageChannel;
  raw?: string;
}) {
  const raw = params.raw?.trim();
  if (!raw) {
    return null;
  }
  const provider = params.channel ?? params.fallbackChannel;
  if (!provider) {
    return null;
  }
  return parseExplicitTargetForLoadedChannel(provider, raw);
}

export function resolveSessionDeliveryTarget(params: {
  entry?: SessionEntry;
  requestedChannel?: GatewayMessageChannel;
  explicitTo?: string;
  explicitThreadId?: string | number;
  fallbackChannel?: DeliverableMessageChannel;
  allowMismatchedLastTo?: boolean;
  mode?: ChannelOutboundTargetMode;
  /**
   * When set, this overrides the session-level `lastChannel` for "last"
   * resolution. This prevents cross-channel reply routing when multiple
   * channels share the same session and an inbound message updates `lastChannel`
   * while an agent turn is still in flight.
   */
  turnSourceChannel?: DeliverableMessageChannel;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): SessionDeliveryTarget {
  const context = deliveryContextFromSession(params.entry);
  const sessionLastChannel =
    context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;
  const parsedSessionTarget = sessionLastChannel
    ? resolveRouteTargetForLoadedChannel({
        channel: sessionLastChannel,
        rawTarget: context?.to,
        fallbackThreadId: context?.threadId,
      })
    : null;

  const hasTurnSourceChannel = params.turnSourceChannel != null;
  const parsedTurnSourceTarget =
    hasTurnSourceChannel && params.turnSourceChannel
      ? resolveRouteTargetForLoadedChannel({
          channel: params.turnSourceChannel,
          rawTarget: params.turnSourceTo,
          fallbackThreadId: params.turnSourceThreadId,
        })
      : null;
  const hasTurnSourceThreadId = parsedTurnSourceTarget?.threadId != null;
  const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
  const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
  const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
  const turnToMatchesSession =
    !params.turnSourceTo ||
    !context?.to ||
    (params.turnSourceChannel === sessionLastChannel &&
      channelRouteTargetsShareConversation({
        left: parsedTurnSourceTarget,
        right: parsedSessionTarget,
      }));
  const lastThreadId = hasTurnSourceThreadId
    ? parsedTurnSourceTarget?.threadId
    : hasTurnSourceChannel &&
        (params.turnSourceChannel !== sessionLastChannel || !turnToMatchesSession)
      ? undefined
      : parsedSessionTarget?.threadId;

  const rawRequested = params.requestedChannel ?? "last";
  const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
  const requestedChannel =
    requested === "last"
      ? "last"
      : requested && isDeliverableMessageChannel(requested)
        ? requested
        : undefined;

  const rawExplicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  const explicitPrefixedChannel =
    requestedChannel === "last" ? resolveTargetPrefixedChannel(rawExplicitTo) : undefined;
  let channel =
    explicitPrefixedChannel && isDeliverableMessageChannel(explicitPrefixedChannel)
      ? explicitPrefixedChannel
      : requestedChannel === "last"
        ? lastChannel
        : requestedChannel;
  if (!channel && params.fallbackChannel && isDeliverableMessageChannel(params.fallbackChannel)) {
    channel = params.fallbackChannel;
  }

  let explicitTo = rawExplicitTo;
  const parsedExplicitTarget = parseExplicitTargetWithPlugin({
    channel,
    fallbackChannel: !channel ? lastChannel : undefined,
    raw: rawExplicitTo,
  });
  if (parsedExplicitTarget?.to) {
    explicitTo = parsedExplicitTarget.to;
  }
  const explicitThreadId =
    params.explicitThreadId != null && params.explicitThreadId !== ""
      ? params.explicitThreadId
      : parsedExplicitTarget?.threadId;

  let to = explicitTo;
  if (!to && lastTo) {
    if (channel && channel === lastChannel) {
      to = lastTo;
    } else if (params.allowMismatchedLastTo) {
      to = lastTo;
    }
  }

  const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");
  const accountId = channel && channel === lastChannel ? lastAccountId : undefined;
  const threadId =
    channel && channel === lastChannel
      ? mode === "heartbeat"
        ? hasTurnSourceThreadId
          ? params.turnSourceThreadId
          : undefined
        : lastThreadId
      : undefined;

  const resolvedThreadId = explicitThreadId ?? threadId;
  return {
    channel,
    to,
    accountId,
    threadId: resolvedThreadId,
    threadIdExplicit: resolvedThreadId != null && explicitThreadId != null,
    mode,
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
}
