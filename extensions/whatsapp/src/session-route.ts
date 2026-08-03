// Whatsapp plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { resolveWhatsAppGroupSessionKey } from "./group-session-key.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = isWhatsAppGroupJid(normalized);
  const isNewsletter = isWhatsAppNewsletterJid(normalized);
  const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
  const route = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: {
      kind: chatType,
      id: normalized,
    },
    chatType,
    from: normalized,
    to: normalized,
  });
  return isGroup
    ? {
        ...route,
        sessionKey: resolveWhatsAppGroupSessionKey({
          sessionKey: route.sessionKey,
          accountId: params.accountId,
        }),
      }
    : route;
}
