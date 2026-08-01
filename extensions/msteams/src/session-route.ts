// Msteams plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { resolveMSTeamsRouteSessionKey } from "./monitor-handler/thread-session.js";

export function resolveMSTeamsOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "msteams", "teams");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isUser = lower.startsWith("user:");
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = normalizeMSTeamsConversationId(rawId);
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const embeddedThreadId = extractMSTeamsConversationMessageId(rawId);
  const explicitThreadId = params.threadId ?? params.replyToId;
  const channelThreadId =
    embeddedThreadId ??
    (explicitThreadId !== undefined && explicitThreadId !== null
      ? String(explicitThreadId)
      : undefined);
  const resolvedKind = params.resolvedTarget?.kind;
  const isCanonicalUserId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    conversationId,
  );
  const recipientSessionExact =
    ((isUser || resolvedKind === "user") && isCanonicalUserId) ||
    (isChannel ? channelThreadId !== undefined : resolvedKind === "group");
  const route = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    recipientSessionExact,
    peer: {
      kind: isUser ? "direct" : isChannel ? "channel" : "group",
      id: conversationId,
    },
    chatType: isUser ? "direct" : isChannel ? "channel" : "group",
    from: isUser
      ? `msteams:${conversationId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`,
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
  return isChannel
    ? {
        ...route,
        sessionKey: resolveMSTeamsRouteSessionKey({
          baseSessionKey: route.baseSessionKey,
          isChannel: true,
          conversationMessageId: channelThreadId,
        }),
        ...(channelThreadId !== undefined ? { threadId: channelThreadId } : {}),
      }
    : route;
}
