import type { SessionEntry } from "../../config/sessions/types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";

export type EffectiveReplyRouteContext = Pick<
  FinalizedMsgContext,
  "Provider" | "Surface" | "OriginatingChannel" | "OriginatingTo" | "AccountId" | "InputProvenance"
>;

export type EffectiveReplyRouteEntry = Pick<
  SessionEntry,
  "deliveryContext" | "lastChannel" | "lastTo" | "lastAccountId" | "route"
>;

export type EffectiveReplyRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  inheritedExternalRoute?: boolean;
};

export function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
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
  const deliveryThreadId = entry?.deliveryContext?.threadId;
  if (deliveryThreadId == null) {
    return undefined;
  }
  const routeThread = entry?.route?.thread;
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

export function resolveEffectiveReplyRoute(params: {
  ctx: EffectiveReplyRouteContext;
  entry?: EffectiveReplyRouteEntry;
}): EffectiveReplyRoute {
  const currentSurface =
    normalizeMessageChannel(params.ctx.Provider) ??
    normalizeMessageChannel(params.ctx.Surface) ??
    normalizeMessageChannel(params.ctx.OriginatingChannel);
  const persistedDeliveryContext = params.entry?.deliveryContext;
  const persistedDeliveryChannel = normalizeMessageChannel(persistedDeliveryContext?.channel);
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
      inheritedExternalRoute: true,
    };
  }
  if (!isSystemEventProvider(params.ctx.Provider)) {
    return {
      channel: params.ctx.OriginatingChannel,
      to: params.ctx.OriginatingTo,
      accountId: params.ctx.AccountId,
    };
  }
  return {
    channel:
      params.ctx.OriginatingChannel ??
      persistedDeliveryContext?.channel ??
      params.entry?.lastChannel,
    to: params.ctx.OriginatingTo ?? persistedDeliveryContext?.to ?? params.entry?.lastTo,
    accountId:
      params.ctx.AccountId ?? persistedDeliveryContext?.accountId ?? params.entry?.lastAccountId,
  };
}
