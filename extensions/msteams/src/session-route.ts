import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveMSTeamsOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "msteams", "teams");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isUser = lower.startsWith("user:");
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
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
}
