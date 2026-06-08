// Qqbot plugin module implements group tool policy behavior.
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveChannelGroupToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";

export function resolveQQBotGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "qqbot",
    groupId: params.groupId,
    groupIdCaseInsensitive: true,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
