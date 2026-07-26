// Telegram group policy checks shared by message-like and callback events.
import type {
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";

export function shouldSkipTelegramGroupMessage(
  params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    resolvedThreadId?: number;
    senderId: string;
    senderUsername: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    cfg: OpenClawConfig;
    telegramCfg: TelegramAccountConfig;
  },
  runtime: Pick<RegisterTelegramHandlerParams, "logger" | "resolveGroupPolicy">,
): boolean {
  const {
    isGroup,
    chatId,
    chatTitle,
    resolvedThreadId,
    senderId,
    senderUsername,
    effectiveGroupAllow,
    hasGroupAllowOverride,
    groupConfig,
    topicConfig,
    cfg,
    telegramCfg,
  } = params;
  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return true;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return true;
    }
    logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`);
    return true;
  }
  if (!isGroup) {
    return false;
  }
  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    resolveGroupPolicy: runtime.resolveGroupPolicy,
    enforcePolicy: true,
    useTopicAndGroupOverrides: true,
    enforceAllowlistAuthorization: true,
    allowEmptyAllowlistEntries: false,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: true,
  });
  if (policyAccess.allowed) {
    return false;
  }
  if (policyAccess.reason === "group-policy-disabled") {
    logVerbose("Blocked telegram group message (groupPolicy: disabled)");
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-no-sender") {
    logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-empty") {
    logVerbose(
      "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
    );
    return true;
  }
  if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
    logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
    return true;
  }
  runtime.logger.info(
    { chatId, title: chatTitle, reason: "not-allowed" },
    "skipping group message",
  );
  return true;
}
