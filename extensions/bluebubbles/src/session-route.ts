import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { parseBlueBubblesTarget } from "./targets.js";

export function resolveBlueBubblesOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "bluebubbles");
  if (!stripped) {
    return null;
  }
  const parsed = parseBlueBubblesTarget(stripped);
  const isGroup =
    parsed.kind === "chat_id" || parsed.kind === "chat_guid" || parsed.kind === "chat_identifier";
  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : parsed.kind === "chat_guid"
        ? parsed.chatGuid
        : parsed.kind === "chat_identifier"
          ? parsed.chatIdentifier
          : parsed.to;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
    to: `bluebubbles:${stripped}`,
  });
}
