import type { SessionEntry } from "../../config/sessions/types.js";
import type { FinalizedMsgContext } from "../templating.js";

export type EffectiveReplyRouteContext = Pick<
  FinalizedMsgContext,
  "Provider" | "OriginatingChannel" | "OriginatingTo" | "AccountId"
>;

export type EffectiveReplyRouteEntry = Pick<
  SessionEntry,
  "deliveryContext" | "lastChannel" | "lastTo" | "lastAccountId"
>;

export type EffectiveReplyRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}

export function resolveEffectiveReplyRoute(params: {
  ctx: EffectiveReplyRouteContext;
  entry?: EffectiveReplyRouteEntry;
}): EffectiveReplyRoute {
  if (!isSystemEventProvider(params.ctx.Provider)) {
    return {
      channel: params.ctx.OriginatingChannel,
      to: params.ctx.OriginatingTo,
      accountId: params.ctx.AccountId,
    };
  }
  const persistedDeliveryContext = params.entry?.deliveryContext;
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
