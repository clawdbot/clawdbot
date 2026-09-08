import {
  resolveChannelGroupPolicy,
  resolveToolsBySender,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
// Telegram helper module supports group config helpers behavior.
import type {
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { firstDefined } from "./bot-access.js";

export function resolveTelegramScopedGroupConfig(
  telegramCfg: TelegramAccountConfig,
  chatId: string | number,
  messageThreadId?: number,
) {
  const resolveTopicConfig = <T extends object>(
    scopedConfig: { topics?: Record<string, T | undefined> } | undefined,
  ): T | undefined => {
    if (!scopedConfig || messageThreadId == null) {
      return undefined;
    }
    const defaultConfig = scopedConfig.topics?.["*"];
    const exactConfig = scopedConfig.topics?.[String(messageThreadId)];
    if (defaultConfig && exactConfig) {
      return { ...defaultConfig, ...exactConfig };
    }
    return exactConfig ?? defaultConfig;
  };
  const chatIdStr = String(chatId);
  const scopedConfigs = chatIdStr.startsWith("-") ? telegramCfg.groups : telegramCfg.direct;
  // Whole-entry selection: an exact chat hides every wildcard field.
  const tree = { scopes: scopedConfigs ?? {} } as ScopeTree;
  const groupKey = Object.hasOwn(tree.scopes, chatIdStr)
    ? chatIdStr
    : Object.hasOwn(tree.scopes, "*")
      ? "*"
      : undefined;
  const path = groupKey ? [groupKey] : [];
  const matchKey = path[0];
  const groupConfig = matchKey ? scopedConfigs?.[matchKey] : undefined;
  const topicConfig = resolveTopicConfig(groupConfig);
  return { groupConfig, topicConfig };
}

export function resolveTelegramGroupIngestEnabled(params: {
  cfg: OpenClawConfig;
  chatId: string | number;
  accountId?: string;
  topicConfig?: TelegramTopicConfig;
}): boolean {
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy({
    cfg: params.cfg,
    channel: "telegram",
    groupId: String(params.chatId),
    accountId: params.accountId,
  });
  return (params.topicConfig?.ingest ?? groupConfig?.ingest ?? defaultConfig?.ingest) === true;
}

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
  const systemPromptParts = [
    params.groupConfig?.systemPrompt?.trim() || null,
    params.topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  return { skillFilter, groupSystemPrompt };
}

export function resolveTelegramDirectToolPolicy(params: {
  directConfig?: Pick<TelegramDirectConfig, "tools" | "toolsBySender">;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
}): GroupToolPolicyConfig | undefined {
  return (
    resolveToolsBySender({
      toolsBySender: params.directConfig?.toolsBySender,
      messageProvider: "telegram",
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
    }) ?? params.directConfig?.tools
  );
}
