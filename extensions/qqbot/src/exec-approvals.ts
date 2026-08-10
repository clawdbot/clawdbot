// Qqbot plugin module implements exec approvals behavior.
import {
  markImplicitSameChatApprovalAuthorization,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultQQBotAccountId, resolveQQBotAccount } from "./bridge/config.js";
import type { QQBotExecApprovalConfig } from "./types.js";

function normalizeApproverId(value: string | number): string | undefined {
  const trimmed = normalizeOptionalString(String(value));
  return trimmed || undefined;
}

export function resolveQQBotExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): QQBotExecApprovalConfig | undefined {
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  const config = account.config.execApprovals;
  if (!config) {
    return undefined;
  }
  return {
    ...config,
    enabled: account.enabled && account.secretSource !== "none" ? config.enabled : false,
  };
}

function getQQBotExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const accountConfig = resolveQQBotAccount(params.cfg, params.accountId).config;
  return resolveApprovalApprovers({
    explicit: resolveQQBotExecApprovalConfig(params)?.approvers,
    allowFrom: accountConfig.allowFrom,
    normalizeApprover: normalizeApproverId,
  });
}

function isQQBotExecApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  if (!account.enabled || account.secretSource === "none") {
    return false;
  }
  const config = resolveQQBotExecApprovalConfig(params);
  return (
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getQQBotExecApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  );
}

function matchesQQBotRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultQQBotAccountId(params.cfg);
  return doesApprovalRequestSelectChannelAccount({
    ...params,
    channel: "qqbot",
    defaultAccountId: resolveDefaultQQBotAccountId(params.cfg),
    eligibleAccountIds: isQQBotExecApprovalAccountEligible({ ...params, accountId })
      ? [accountId]
      : [],
  });
}

function matchesQQBotFallbackRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultQQBotAccountId(params.cfg);
  const account = resolveQQBotAccount(params.cfg, accountId);
  return doesApprovalRequestSelectChannelAccount({
    ...params,
    channel: "qqbot",
    defaultAccountId: resolveDefaultQQBotAccountId(params.cfg),
    eligibleAccountIds: account.enabled && account.secretSource !== "none" ? [accountId] : [],
  });
}

/**
 * Minimal structural shape required to evaluate per-account ownership.
 *
 * The SDK types (`ExecApprovalRequest` / `PluginApprovalRequest`) and the
 * channel-local approval request types (see `engine/approval/index.ts`)
 * share the same logical fields but differ on bookkeeping metadata
 * (e.g. `createdAtMs`), so we accept any object exposing the relevant
 * routing fields. Consumers can pass either flavor safely.
 */
type QQBotApprovalAccountOwnershipRequest = {
  request: {
    sessionKey?: string | null;
    turnSourceChannel?: string | null;
    turnSourceTo?: string | null;
    turnSourceAccountId?: string | null;
  };
};

/**
 * Unified per-account ownership check used by both the profile and
 * fallback approval paths. Dispatches to the profile rules when the
 * current account has `execApprovals` configured, otherwise uses the
 * fallback rules.
 *
 * This is the single source of truth for "does this QQBot handler own
 * this approval request?" and is consumed by both the capability
 * gate (shouldHandle) and the lazy native runtime adapter.
 */
export function matchesQQBotApprovalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: QQBotApprovalAccountOwnershipRequest;
}): boolean {
  const normalized = {
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request as unknown as ExecApprovalRequest | PluginApprovalRequest,
  };
  if (resolveQQBotExecApprovalConfig(normalized) !== undefined) {
    return matchesQQBotRequestAccount(normalized);
  }
  return matchesQQBotFallbackRequestAccount(normalized);
}

const qqbotExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveQQBotExecApprovalConfig,
  resolveApprovers: getQQBotExecApprovalApprovers,
  matchesRequestAccount: matchesQQBotRequestAccount,
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isQQBotExecApprovalClientEnabled = qqbotExecApprovalProfile.isClientEnabled;
const isQQBotExecApprovalApprover = qqbotExecApprovalProfile.isApprover;
const isQQBotExecApprovalAuthorizedSender = qqbotExecApprovalProfile.isAuthorizedSender;
export const shouldHandleQQBotExecApprovalRequest = qqbotExecApprovalProfile.shouldHandleRequest;

export function authorizeQQBotApprovalAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  approvalKind: "exec" | "plugin";
}): { authorized: boolean; reason?: string } {
  if (resolveQQBotExecApprovalConfig(params) === undefined) {
    return markImplicitSameChatApprovalAuthorization({ authorized: true });
  }

  const authorized =
    params.approvalKind === "plugin"
      ? isQQBotExecApprovalApprover(params)
      : isQQBotExecApprovalAuthorizedSender(params);
  return authorized
    ? { authorized: true }
    : { authorized: false, reason: "You are not authorized to approve this request." };
}
