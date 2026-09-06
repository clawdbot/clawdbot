// Telegram plugin module implements exec approvals behavior.
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  OpenClawConfig,
  TelegramExecApprovalConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultTelegramAccountId, resolveTelegramAccount } from "./accounts.js";
import { normalizeTelegramChatId, resolveTelegramTargetChatType } from "./targets.js";

function normalizeApproverId(value: string | number): string {
  return normalizeOptionalString(String(value)) ?? "";
}

function normalizeTelegramDirectApproverId(value: string | number): string | undefined {
  const normalized = normalizeApproverId(value);
  const chatId = normalizeTelegramChatId(normalized);
  if (!chatId || chatId.startsWith("-")) {
    return undefined;
  }
  return chatId;
}

function resolveTelegramOwnerApprovers(cfg: OpenClawConfig): Array<string | number> {
  const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
  return Array.isArray(ownerAllowFrom) ? ownerAllowFrom : [];
}

export function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined {
  const account = resolveTelegramAccount(params);
  const config = account.config.execApprovals;
  const enabled =
    account.enabled && account.tokenSource !== "none" ? (config?.enabled ?? "auto") : false;
  return {
    ...config,
    enabled,
  };
}

export function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveApprovalApprovers({
    explicit: resolveTelegramExecApprovalConfig(params)?.approvers,
    allowFrom: resolveTelegramOwnerApprovers(params.cfg),
    normalizeApprover: normalizeTelegramDirectApproverId,
  });
}

export function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "telegram",
    matchTarget: ({ target, normalizedSenderId }) => {
      const to = target.to ? normalizeTelegramChatId(target.to) : undefined;
      if (!to || to.startsWith("-")) {
        return false;
      }
      return to === normalizedSenderId;
    },
  });
}

function isTelegramExecApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
}): boolean {
  const account = resolveTelegramAccount(params);
  if (!account.enabled || account.tokenSource === "none") {
    return false;
  }
  const config = resolveTelegramExecApprovalConfig(params);
  return (
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getTelegramExecApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  );
}

function matchesTelegramRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
  return doesApprovalRequestSelectChannelAccount({
    ...params,
    channel: "telegram",
    defaultAccountId: resolveDefaultTelegramAccountId(params.cfg),
    eligibleAccountIds: isTelegramExecApprovalAccountEligible({ ...params, accountId })
      ? [accountId]
      : [],
  });
}

const telegramExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveTelegramExecApprovalConfig,
  resolveApprovers: getTelegramExecApprovalApprovers,
  isTargetRecipient: isTelegramExecApprovalTargetRecipient,
  matchesRequestAccount: matchesTelegramRequestAccount,
  // Telegram session keys often carry the only stable agent ID for approval routing.
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isTelegramExecApprovalClientEnabled = telegramExecApprovalProfile.isClientEnabled;
export const isTelegramExecApprovalApprover = telegramExecApprovalProfile.isApprover;
export const isTelegramExecApprovalAuthorizedSender =
  telegramExecApprovalProfile.isAuthorizedSender;
export const resolveTelegramExecApprovalTarget = telegramExecApprovalProfile.resolveTarget;
export const shouldHandleTelegramExecApprovalRequest =
  telegramExecApprovalProfile.shouldHandleRequest;

export function shouldInjectTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean {
  if (!isTelegramExecApprovalClientEnabled(params)) {
    return false;
  }
  const target = resolveTelegramExecApprovalTarget(params);
  const chatType = resolveTelegramTargetChatType(params.to);
  if (chatType === "direct") {
    return target === "dm" || target === "both";
  }
  if (chatType === "group") {
    return target === "channel" || target === "both";
  }
  return target === "both";
}

export function shouldSuppressLocalTelegramExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return telegramExecApprovalProfile.shouldSuppressLocalPrompt(params);
}

export function isTelegramExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: resolveTelegramExecApprovalConfig(params)?.enabled,
    approverCount: getTelegramExecApprovalApprovers(params).length,
  });
}
