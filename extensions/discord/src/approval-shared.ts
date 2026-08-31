// Discord plugin module implements approval shared behavior.
import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultDiscordAccountId, resolveDiscordAccount } from "./accounts.js";
import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "./approval-runtime.js";
import { getDiscordExecApprovalApprovers } from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

function isDiscordApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const account = resolveDiscordAccount(params);
  const config = params.configOverride ?? account.config.execApprovals;
  return (
    account.enabled &&
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getDiscordExecApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
    })
  );
}

export function shouldHandleDiscordApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  if (
    !doesApprovalRequestSelectChannelAccount({
      ...params,
      channel: "discord",
      defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
      eligibleAccountIds: isDiscordApprovalAccountEligible({ ...params, accountId })
        ? [accountId]
        : [],
    })
  ) {
    return false;
  }
  return isDiscordApprovalAccountEligible(params);
}
