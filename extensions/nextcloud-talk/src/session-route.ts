import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";

export function resolveNextcloudTalkOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: roomId,
    },
    chatType: "group",
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  });
}
