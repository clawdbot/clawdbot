/** Resolves the effective reply route from current context and persisted session route. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "../../infra/outbound/channel-target-prefix.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";

/** Current finalized context fields used for reply route resolution. */
type EffectiveReplyRouteContext = Pick<
  FinalizedMsgContext,
  | "Provider"
  | "Surface"
  | "OriginatingChannel"
  | "OriginatingTo"
  | "MessageThreadId"
  | "AccountId"
  | "InputProvenance"
  | "InternalTurnSource"
  | "ChatType"
>;

/** Persisted session fields used as route fallback/inheritance. */
type EffectiveReplyRouteEntry = Pick<SessionEntry, "delivery" | "chatType">;

/** Effective channel target selected for source reply delivery. */
export type EffectiveReplyRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  chatType?: ChatType;
  inheritedExternalRoute?: boolean;
};

/** Normalizes an external target without collapsing provider-owned topic suffixes. */
export function normalizeEffectiveReplyTarget(
  raw: string | undefined,
  channel: string | null | undefined,
  threadId?: string | number,
): string | undefined {
  let target = normalizeOptionalString(raw);
  if (target && channel && threadId != null) {
    // The channel owns whether a separate thread is part of its conversation ID.
    // Use the same identity for stored-context matching and group policy lookup.
    target =
      getLoadedChannelPluginForRead(channel)?.threading?.resolveCurrentChannelId?.({
        to: target,
        threadId,
      }) ?? target;
  }
  return target
    ? normalizeOptionalString(
        stripOutboundTargetKindPrefix(stripTargetProviderPrefix(target, channel ?? "")),
      )
    : undefined;
}

function isSessionsSendInterSessionHandoff(inputProvenance: InputProvenance | undefined): boolean {
  return (
    inputProvenance?.kind === "inter_session" &&
    inputProvenance.sourceTool?.toLowerCase() === "sessions_send"
  );
}

function resolveTrustedInheritedThreadId(
  entry: EffectiveReplyRouteEntry | undefined,
): string | number | undefined {
  const deliveryThreadId = deliveryContextFromSession(entry)?.threadId;
  if (deliveryThreadId == null) {
    return undefined;
  }
  const routeThread = sessionDeliveryRoute(entry)?.thread;
  if (
    routeThread?.id != null &&
    (routeThread.source === "explicit" ||
      routeThread.source === "target" ||
      routeThread.source === "turn") &&
    stringifyRouteThreadId(routeThread.id) === stringifyRouteThreadId(deliveryThreadId)
  ) {
    return deliveryThreadId;
  }
  return undefined;
}

/** Resolves current, inherited, or persisted reply route for a session turn. */
export function resolveEffectiveReplyRoute(params: {
  ctx: EffectiveReplyRouteContext;
  entry?: EffectiveReplyRouteEntry;
}): EffectiveReplyRoute {
  const currentSurface =
    normalizeMessageChannel(params.ctx.Provider) ??
    normalizeMessageChannel(params.ctx.Surface) ??
    normalizeMessageChannel(params.ctx.OriginatingChannel);
  const persistedDeliveryContext = deliveryContextFromSession(params.entry);
  const persistedRoute = sessionDeliveryRoute(params.entry);
  const persistedOrigin = sessionDeliveryOrigin(params.entry);
  const persistedDeliveryChannel = normalizeMessageChannel(persistedDeliveryContext?.channel);
  const liveChatType = normalizeChatType(params.ctx.ChatType);
  const persistedChatType =
    persistedRoute?.target?.chatType ??
    params.entry?.chatType ??
    normalizeChatType(persistedOrigin?.chatType);
  if (
    isSessionsSendInterSessionHandoff(params.ctx.InputProvenance) &&
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    persistedDeliveryChannel &&
    persistedDeliveryChannel !== INTERNAL_MESSAGE_CHANNEL &&
    persistedDeliveryContext?.to
  ) {
    const inheritedThreadId = resolveTrustedInheritedThreadId(params.entry);
    return {
      channel: persistedDeliveryChannel,
      to: persistedDeliveryContext.to,
      accountId: persistedDeliveryContext.accountId,
      ...(inheritedThreadId !== undefined ? { threadId: inheritedThreadId } : {}),
      ...(persistedChatType ? { chatType: persistedChatType } : {}),
      inheritedExternalRoute: true,
    };
  }
  if (params.ctx.InternalTurnSource === undefined) {
    return {
      channel: params.ctx.OriginatingChannel,
      to: params.ctx.OriginatingTo,
      accountId: params.ctx.AccountId,
      ...(params.ctx.MessageThreadId !== undefined ? { threadId: params.ctx.MessageThreadId } : {}),
      ...(liveChatType ? { chatType: liveChatType } : {}),
    };
  }
  const persistedChannel = persistedDeliveryContext?.channel;
  const liveChannel = params.ctx.OriginatingChannel;
  const canInheritPersistedTuple =
    !liveChannel ||
    normalizeMessageChannel(liveChannel) === normalizeMessageChannel(persistedChannel);
  const chatType = liveChatType ?? (canInheritPersistedTuple ? persistedChatType : undefined);
  return {
    channel: liveChannel ?? persistedChannel,
    to:
      params.ctx.OriginatingTo ??
      (canInheritPersistedTuple ? persistedDeliveryContext?.to : undefined),
    accountId:
      params.ctx.AccountId ??
      (canInheritPersistedTuple ? persistedDeliveryContext?.accountId : undefined),
    ...(params.ctx.MessageThreadId !== undefined ? { threadId: params.ctx.MessageThreadId } : {}),
    ...(chatType ? { chatType } : {}),
  };
}
