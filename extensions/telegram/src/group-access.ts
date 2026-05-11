import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { isSenderAllowed, type NormalizedAllowFrom } from "./bot-access.js";
import { firstDefined } from "./bot-access.js";

type TelegramGroupBaseBlockReason =
  | "group-disabled"
  | "topic-disabled"
  | "group-override-unauthorized";

type TelegramGroupBaseAccessResult =
  | { allowed: true }
  | { allowed: false; reason: TelegramGroupBaseBlockReason };

function isGroupAllowOverrideAuthorized(params: {
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  requireSenderForAllowOverride: boolean;
}): boolean {
  if (!params.effectiveGroupAllow.hasEntries) {
    return false;
  }
  const senderId = params.senderId ?? "";
  if (params.requireSenderForAllowOverride && !senderId) {
    return false;
  }
  return isSenderAllowed({
    allow: params.effectiveGroupAllow,
    senderId,
    senderUsername: params.senderUsername ?? "",
  });
}

export const evaluateTelegramGroupBaseAccess = (params: {
  isGroup: boolean;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  hasGroupAllowOverride: boolean;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  enforceAllowOverride: boolean;
  requireSenderForAllowOverride: boolean;
}): TelegramGroupBaseAccessResult => {
  // Check enabled flags for both groups and DMs
  if (params.groupConfig?.enabled === false) {
    return { allowed: false, reason: "group-disabled" };
  }
  if (params.topicConfig?.enabled === false) {
    return { allowed: false, reason: "topic-disabled" };
  }
  if (!params.isGroup) {
    // For DMs, check allowFrom override if present
    if (params.enforceAllowOverride && params.hasGroupAllowOverride) {
      if (
        !isGroupAllowOverrideAuthorized({
          effectiveGroupAllow: params.effectiveGroupAllow,
          senderId: params.senderId,
          senderUsername: params.senderUsername,
          requireSenderForAllowOverride: params.requireSenderForAllowOverride,
        })
      ) {
        return { allowed: false, reason: "group-override-unauthorized" };
      }
    }
    return { allowed: true };
  }
  if (!params.enforceAllowOverride || !params.hasGroupAllowOverride) {
    return { allowed: true };
  }

  if (
    !isGroupAllowOverrideAuthorized({
      effectiveGroupAllow: params.effectiveGroupAllow,
      senderId: params.senderId,
      senderUsername: params.senderUsername,
      requireSenderForAllowOverride: params.requireSenderForAllowOverride,
    })
  ) {
    return { allowed: false, reason: "group-override-unauthorized" };
  }
  return { allowed: true };
};

type TelegramGroupPolicyBlockReason =
  | "group-policy-disabled"
  | "group-policy-allowlist-no-sender"
  | "group-policy-allowlist-empty"
  | "group-policy-allowlist-unauthorized"
  | "group-chat-not-allowed";

type TelegramGroupPolicyAccessResult =
  | { allowed: true; groupPolicy: "open" | "disabled" | "allowlist" }
  | {
      allowed: false;
      reason: TelegramGroupPolicyBlockReason;
      groupPolicy: "open" | "disabled" | "allowlist";
    };

export const resolveTelegramRuntimeGroupPolicy = (params: {
  providerConfigPresent: boolean;
  groupPolicy?: TelegramAccountConfig["groupPolicy"];
  defaultGroupPolicy?: TelegramAccountConfig["groupPolicy"];
}) =>
  resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });

export const evaluateTelegramGroupPolicyAccess = (params: {
  isGroup: boolean;
  chatId: string | number;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  topicConfig?: TelegramTopicConfig;
  groupConfig?: TelegramGroupConfig;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  enforcePolicy: boolean;
  useTopicAndGroupOverrides: boolean;
  enforceAllowlistAuthorization: boolean;
  allowEmptyAllowlistEntries: boolean;
  requireSenderForAllowlistAuthorization: boolean;
  checkChatAllowlist: boolean;
}): TelegramGroupPolicyAccessResult => {
  const { groupPolicy: runtimeFallbackPolicy } = resolveTelegramRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.telegram !== undefined,
    groupPolicy: params.telegramCfg.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const fallbackPolicy =
    firstDefined(params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ??
    runtimeFallbackPolicy;
  const groupPolicy = params.useTopicAndGroupOverrides
    ? (firstDefined(
        params.topicConfig?.groupPolicy,
        params.groupConfig?.groupPolicy,
        params.telegramCfg.groupPolicy,
        params.cfg.channels?.defaults?.groupPolicy,
      ) ?? runtimeFallbackPolicy)
    : fallbackPolicy;

  if (!params.isGroup || !params.enforcePolicy) {
    return { allowed: true, groupPolicy };
  }
  if (groupPolicy === "disabled") {
    return { allowed: false, reason: "group-policy-disabled", groupPolicy };
  }
  // Check chat-level allowlist first so that groups explicitly listed in the
  // `groups` config are not blocked by the sender-level "empty allowlist" guard.
  let chatExplicitlyAllowed = false;
  if (params.checkChatAllowlist) {
    const groupAllowlist = params.resolveGroupPolicy(params.chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      return { allowed: false, reason: "group-chat-not-allowed", groupPolicy };
    }
    // The chat is explicitly allowed when it has a dedicated entry in the groups
    // config (groupConfig is set).  A wildcard ("*") match alone does not count
    // because it only enables the group — sender-level filtering still applies.
    if (groupAllowlist.allowlistEnabled && groupAllowlist.allowed && groupAllowlist.groupConfig) {
      chatExplicitlyAllowed = true;
    }
  }
  if (groupPolicy === "allowlist" && params.enforceAllowlistAuthorization) {
    const senderId = params.senderId ?? "";
    const allowlistConfigured =
      chatExplicitlyAllowed ||
      params.allowEmptyAllowlistEntries ||
      params.effectiveGroupAllow.hasEntries;
    const allowlistMatched =
      (chatExplicitlyAllowed && !params.effectiveGroupAllow.hasEntries) ||
      isSenderAllowed({
        allow: params.effectiveGroupAllow,
        senderId,
        senderUsername: params.senderUsername ?? "",
      });
    if (params.requireSenderForAllowlistAuthorization && !senderId) {
      return { allowed: false, reason: "group-policy-allowlist-no-sender", groupPolicy };
    }
    if (!allowlistConfigured) {
      return { allowed: false, reason: "group-policy-allowlist-empty", groupPolicy };
    }
    if (!allowlistMatched) {
      return { allowed: false, reason: "group-policy-allowlist-unauthorized", groupPolicy };
    }
  }
  return { allowed: true, groupPolicy };
};
