import {
  buildChannelOutboundSessionRoute,
  resolveThreadSessionKeys,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeOutboundThreadId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveMattermostOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "mattermost");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const resolvedKind = params.resolvedTarget?.kind;
  const isUser =
    resolvedKind === "user" ||
    (resolvedKind !== "channel" &&
      resolvedKind !== "group" &&
      (lower.startsWith("user:") || trimmed.startsWith("@")));
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer: {
      kind: isUser ? "direct" : "channel",
      id: rawId,
    },
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
  const threadId = normalizeOutboundThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: baseRoute.baseSessionKey,
    threadId,
  });
  return {
    ...baseRoute,
    sessionKey: threadKeys.sessionKey,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}
