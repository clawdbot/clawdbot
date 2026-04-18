import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildOutboundBaseSessionKey } from "openclaw/plugin-sdk/routing";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";

type NextcloudTalkOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
};

export function resolveNextcloudTalkOutboundSessionRoute(
  params: NextcloudTalkOutboundSessionRouteParams,
) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: roomId,
    },
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: {
      kind: "group" as const,
      id: roomId,
    },
    chatType: "group" as const,
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  };
}
