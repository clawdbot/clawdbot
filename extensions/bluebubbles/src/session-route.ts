import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { resolveGroupFlagFromChatGuid } from "./monitor-normalize.js";
import { extractHandleFromChatGuid, parseBlueBubblesTarget } from "./targets.js";

export function resolveBlueBubblesOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "bluebubbles");
  if (!stripped) {
    return null;
  }
  const parsed = parseBlueBubblesTarget(stripped);
  // chat_guid carries an explicit DM-vs-group marker (`;-;` for DMs,
  // `;+;` for groups). Honor it so the same DM does not get one
  // sessionKey for handle-form targets (`imessage:+1234`) and a
  // different one for chat_guid-form targets
  // (`chat_guid:iMessage;-;+1234`) — that mismatch made bound DM
  // sessions mis-route the outbound back into a freshly-created
  // "group" sessionKey.
  const groupFromChatGuid =
    parsed.kind === "chat_guid" ? resolveGroupFlagFromChatGuid(parsed.chatGuid) : undefined;
  const isGroup =
    parsed.kind === "chat_id" || parsed.kind === "chat_identifier"
      ? true
      : parsed.kind === "chat_guid"
        ? (groupFromChatGuid ?? true)
        : false;
  const dmHandleFromChatGuid =
    parsed.kind === "chat_guid" && groupFromChatGuid === false
      ? extractHandleFromChatGuid(parsed.chatGuid)
      : null;
  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : parsed.kind === "chat_guid"
        ? (dmHandleFromChatGuid ?? parsed.chatGuid)
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
