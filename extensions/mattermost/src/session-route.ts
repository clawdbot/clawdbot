// Mattermost plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Reads the peer chat-kind already recorded for `peerId` in an agent session
 * key. Agent session keys are
 * `agent:<agentId>:mattermost:<direct|group|channel>:<peerId>[:thread:...]`, so
 * the segment right after `mattermost:` is the authoritative inbound chat kind.
 */
function mattermostSessionKeyPeerKind(
  sessionKey: string | null | undefined,
  peerId: string,
): "direct" | "group" | "channel" | undefined {
  if (!sessionKey || !peerId) {
    return undefined;
  }
  const match = /:mattermost:(direct|group|channel):([^:]+)/i.exec(sessionKey);
  if (!match || match[2] !== peerId) {
    return undefined;
  }
  return match[1].toLowerCase() as "direct" | "group" | "channel";
}

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
  const hasExplicitUserKind = resolvedKind === "user" || lower.startsWith("user:");
  // User ids map to inbound DM sender ids. Channel ids do not encode whether
  // the conversation is public, private, or a group DM, so they stay inexact.
  const recipientSessionExact = isUser && hasExplicitUserKind && /^[a-z0-9]{26}$/.test(rawId);
  // A Mattermost private channel / group DM is authoritatively `group`, but it is
  // addressed as `channel:<id>` (the same prefix as a public channel). Without an
  // authoritative signal the outbound route would key it as `channel`, forking a
  // phantom `channel:<id>` session from the inbound `group:<id>` one and breaking
  // threaded/scheduled delivery (#95646). Honor a group signal from the resolved
  // target, an explicit `group:` prefix, or the inbound session key for this peer.
  const isGroup =
    !isUser &&
    (resolvedKind === "group" ||
      lower.startsWith("group:") ||
      mattermostSessionKeyPeerKind(params.currentSessionKey, rawId) === "group");
  const kind: "direct" | "group" | "channel" = isUser ? "direct" : isGroup ? "group" : "channel";
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    recipientSessionExact,
    peer: {
      kind,
      id: rawId,
    },
    chatType: kind,
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    // Wire target stays `channel:<id>` for non-DMs: Mattermost posts to the channel
    // id regardless of private/public, and `parseMattermostTarget` only accepts
    // `channel:`/`user:`. The `group` distinction lives in the session key (peer.kind).
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    canRecoverCurrentThread: ({ route }) =>
      route.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
}
