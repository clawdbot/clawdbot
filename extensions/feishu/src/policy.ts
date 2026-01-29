import type { GroupToolPolicyConfig, MoltbotConfig } from "clawdbot/plugin-sdk";
import { normalizeAccountId, resolveToolsBySender } from "clawdbot/plugin-sdk";

type FeishuGroupConfig = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: Record<string, GroupToolPolicyConfig>;
};

type FeishuGroupsConfig = Record<string, FeishuGroupConfig | undefined> | undefined;

function resolveGroupsConfig(
  cfg: MoltbotConfig,
  accountId?: string | null,
): FeishuGroupsConfig {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.feishu as
    | {
        accounts?: Record<string, { groups?: FeishuGroupsConfig }>;
        groups?: FeishuGroupsConfig;
      }
    | undefined;
  if (!channelConfig) return undefined;
  const accountGroups =
    channelConfig.accounts?.[normalizedAccountId]?.groups ??
    channelConfig.accounts?.[
      Object.keys(channelConfig.accounts ?? {}).find(
        (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
      ) ?? ""
    ]?.groups;
  return accountGroups ?? channelConfig.groups;
}

export function resolveFeishuGroupToolPolicy(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
}): GroupToolPolicyConfig | undefined {
  const groups = resolveGroupsConfig(params.cfg, params.accountId);
  if (!groups) return undefined;
  const groupId = params.groupId?.trim();
  const groupConfig = groupId ? groups[groupId] : undefined;
  const defaultConfig = groups["*"];
  const groupSenderPolicy = resolveToolsBySender({
    toolsBySender: groupConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
  });
  if (groupSenderPolicy) return groupSenderPolicy;
  if (groupConfig?.tools) return groupConfig.tools;
  const defaultSenderPolicy = resolveToolsBySender({
    toolsBySender: defaultConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
  });
  if (defaultSenderPolicy) return defaultSenderPolicy;
  return defaultConfig?.tools;
}
