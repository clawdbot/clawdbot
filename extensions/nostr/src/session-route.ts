// Nostr plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizePubkey } from "./nostr-key-utils.js";

export function resolveNostrOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const rawTarget = stripChannelTargetPrefix(params.target, "nostr");
  let target: string;
  try {
    target = normalizePubkey(rawTarget);
  } catch {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: {
      kind: "direct",
      id: target,
    },
    chatType: "direct",
    from: `nostr:${target}`,
    to: `nostr:${target}`,
  });
}
