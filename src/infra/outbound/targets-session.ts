// Session target resolution chooses the effective channel, destination,
// account, and thread from explicit input, turn source, or session history.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import { channelRouteTargetsShareConversation } from "../../plugin-sdk/channel-route.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import {
  isNormalizedMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel-core.js";
import { resolveTargetPrefixedChannel } from "./channel-target-prefix.js";

/**
 * Resolved delivery destination derived from session history, turn source, or explicit input.
 */
export type SessionDeliveryTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  threadIdSource?: "explicit" | "session" | "turn-source";
  mode: ChannelOutboundTargetMode;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

function resolveRouteTarget(params: {
  channel: string;
  accountId?: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}) {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const rawTo = normalizeOptionalString(params.rawTarget);
  if (!channel || !rawTo) {
    return null;
  }
  const threadId = normalizeOptionalThreadValue(params.fallbackThreadId);
  return {
    channel,
    accountId: params.accountId,
    rawTo,
    to: rawTo,
    ...(threadId != null ? { threadId } : {}),
  };
}

/**
 * Resolves the effective outbound target for a session-scoped delivery request.
 */
export function resolveSessionDeliveryTarget(params: {
  entry?: SessionEntry;
  requestedChannel?: string;
  explicitTo?: string;
  explicitThreadId?: string | number;
  fallbackChannel?: string;
  allowMismatchedLastTo?: boolean;
  mode?: ChannelOutboundTargetMode;
  /**
   * When set, this overrides the session-level `lastChannel` for "last"
   * resolution. This prevents cross-channel reply routing when multiple
   * channels share the same session and an inbound message updates `lastChannel`
   * while an agent turn is still in flight.
   */
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): SessionDeliveryTarget {
  const context = deliveryContextFromSession(params.entry);
  const sessionLastChannel =
    context?.channel && isNormalizedMessageChannel(context.channel) ? context.channel : undefined;
  const parsedSessionTarget = sessionLastChannel
    ? resolveRouteTarget({
        channel: sessionLastChannel,
        accountId: context?.accountId,
        rawTarget: context?.to,
        fallbackThreadId: context?.threadId,
      })
    : null;

  const hasTurnSourceChannel = params.turnSourceChannel != null;
  const parsedTurnSourceTarget =
    hasTurnSourceChannel && params.turnSourceChannel
      ? resolveRouteTarget({
          channel: params.turnSourceChannel,
          accountId: params.turnSourceAccountId,
          rawTarget: params.turnSourceTo,
          fallbackThreadId: params.turnSourceThreadId,
        })
      : null;
  const hasTurnSourceThreadId = parsedTurnSourceTarget?.threadId != null;
  const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
  const lastTo = hasTurnSourceChannel
    ? (parsedTurnSourceTarget?.to ?? params.turnSourceTo)
    : (parsedSessionTarget?.to ?? context?.to);
  const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
  const turnToMatchesSession =
    !params.turnSourceTo ||
    !context?.to ||
    (params.turnSourceChannel === sessionLastChannel &&
      channelRouteTargetsShareConversation({
        left: parsedTurnSourceTarget,
        right: parsedSessionTarget,
      }));
  // Shared sessions can receive cross-channel or cross-account updates mid-turn;
  // only inherit session threads from the same account-scoped conversation.
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
      : requested && isNormalizedMessageChannel(requested)
        ? requested
        : undefined;

  const rawExplicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  const explicitPrefixedChannel =
    requestedChannel === "last" ? resolveTargetPrefixedChannel(rawExplicitTo) : undefined;
  let channel =
    explicitPrefixedChannel && isNormalizedMessageChannel(explicitPrefixedChannel)
      ? explicitPrefixedChannel
      : requestedChannel === "last"
        ? lastChannel
        : requestedChannel;
  if (!channel && params.fallbackChannel && isNormalizedMessageChannel(params.fallbackChannel)) {
    channel = params.fallbackChannel;
  }

  const explicitTarget =
    channel && rawExplicitTo
      ? resolveRouteTarget({
          channel,
          rawTarget: rawExplicitTo,
          fallbackThreadId: params.explicitThreadId,
        })
      : null;
  const explicitTo = explicitTarget?.to ?? rawExplicitTo;
  const explicitThreadId = normalizeOptionalThreadValue(
    explicitTarget?.threadId ?? params.explicitThreadId,
  );
  const explicitThreadIdSource = explicitThreadId != null ? "explicit" : undefined;

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

  const inheritedThreadIdSource =
    threadId != null ? (hasTurnSourceThreadId ? "turn-source" : "session") : undefined;
  const resolvedThreadId = explicitThreadId ?? threadId;
  return {
    channel,
    to,
    accountId,
    threadId: resolvedThreadId,
    threadIdSource: explicitThreadIdSource ?? inheritedThreadIdSource,
    mode,
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
}
