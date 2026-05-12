import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { resolveApprovalRequestChannelAccountId } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listQQBotAccountIds, resolveQQBotAccount } from "./bridge/config.js";
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

function countQQBotExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): number {
  return listQQBotAccountIds(params.cfg).filter((accountId) => {
    const account = resolveQQBotAccount(params.cfg, accountId);
    if (!account.enabled || account.secretSource === "none") {
      return false;
    }
    const config = resolveQQBotExecApprovalConfig({
      cfg: params.cfg,
      accountId,
    });
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount: getQQBotExecApprovalApprovers({ cfg: params.cfg, accountId }).length,
      }) &&
      matchesApprovalRequestFilters({
        request: params.request.request,
        agentFilter: config?.agentFilter,
        sessionFilter: config?.sessionFilter,
        fallbackAgentIdFromSessionKey: true,
      })
    );
  }).length;
}

function matchesQQBotRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(
    params.request.request.turnSourceChannel,
  );
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "qqbot",
  });
  if (turnSourceChannel && turnSourceChannel !== "qqbot" && !boundAccountId) {
    return (
      countQQBotExecApprovalEligibleAccounts({
        cfg: params.cfg,
        request: params.request,
      }) <= 1
    );
  }
  return (
    !boundAccountId ||
    !params.accountId ||
    normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId)
  );
}

/**
 * Count QQBot accounts that could actually deliver a native approval
 * message — i.e. accounts that are enabled and have resolvable secrets.
 * Disabled or unconfigured accounts never spawn a handler, so they
 * must not contribute to the single-account shortcut in the fallback
 * ownership check below.
 */
function countQQBotFallbackEligibleAccounts(cfg: OpenClawConfig): number {
  return listQQBotAccountIds(cfg).filter((accountId) => {
    const account = resolveQQBotAccount(cfg, accountId);
    return account.enabled && account.secretSource !== "none";
  }).length;
}

/**
 * Fallback account-ownership check — applied when `execApprovals` is NOT
 * configured for any QQBot account. In this mode every enabled account
 * handler would otherwise race to deliver the same approval to its own
 * openid namespace, so we must enforce per-account isolation.
 *
 * Rules:
 *   - If the request carries a bound account (via `turnSourceAccountId`
 *     or session binding), only the handler whose `accountId` matches it
 *     delivers the approval. This is strict: a handler with an unknown
 *     `accountId` (null/undefined) must not claim a bound request.
 *   - If no account is bound, only deliver when there is a single
 *     *eligible* QQBot account (enabled + secret resolved). Disabled or
 *     unconfigured accounts never deliver anyway, so they shouldn't
 *     block the remaining single account from handling the approval.
 *     Multiple eligible accounts cannot safely race because openids are
 *     account-scoped — cross-account delivery hits the QQ Bot API with
 *     a mismatched token and fails.
 */
function matchesQQBotFallbackRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "qqbot",
  });

  if (boundAccountId) {
    if (!params.accountId) {
      return false;
    }
    return normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId);
  }

  return countQQBotFallbackEligibleAccounts(params.cfg) <= 1;
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
export const isQQBotExecApprovalApprover = qqbotExecApprovalProfile.isApprover;
export const isQQBotExecApprovalAuthorizedSender = qqbotExecApprovalProfile.isAuthorizedSender;
export const shouldHandleQQBotExecApprovalRequest = qqbotExecApprovalProfile.shouldHandleRequest;

export function authorizeQQBotApprovalAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  approvalKind: "exec" | "plugin";
}): { authorized: boolean; reason?: string } {
  if (resolveQQBotExecApprovalConfig(params) === undefined) {
    return { authorized: true };
  }

  const authorized =
    params.approvalKind === "plugin"
      ? isQQBotExecApprovalApprover(params)
      : isQQBotExecApprovalAuthorizedSender(params);
  return authorized
    ? { authorized: true }
    : { authorized: false, reason: "You are not authorized to approve this request." };
}
