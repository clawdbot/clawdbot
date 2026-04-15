import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";

export function resolveNostrOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target = stripChannelTargetPrefix(params.target, "nostr");
  if (!target) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    peer: {
      kind: "direct",
      id: target,
    },
    chatType: "direct",
    from: `nostr:${target}`,
    to: `nostr:${target}`,
  });
}
