import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

type BlueBubblesGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

export function resolveBlueBubblesGroupRequireMention(params: BlueBubblesGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "bluebubbles",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}

export function resolveBlueBubblesGroupToolPolicy(
  params: BlueBubblesGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "bluebubbles",
    groupId: params.groupId,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
