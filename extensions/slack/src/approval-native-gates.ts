import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { getSlackApprovalApprovers } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalClientEnabled,
} from "./exec-approvals.js";

export type SlackApprovalKind = "exec" | "plugin";
export type SlackNativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function resolveSlackApprovalKind(request: SlackNativeApprovalRequest): SlackApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

function resolveSlackNativeApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return resolveSlackAccount(params).config.execApprovals;
}

function resolvePluginApprovalForwardingConfig(cfg: OpenClawConfig) {
  return cfg.approvals?.plugin;
}

function getSlackNativeApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: SlackApprovalKind;
}): string[] {
  return params.approvalKind === "plugin"
    ? getSlackApprovalApprovers(params)
    : getSlackExecApprovalApprovers(params);
}

function normalizeAccountId(value?: string | null): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

function matchesSlackAccount(params: {
  expectedAccountId?: string | null;
  actualAccountId?: string | null;
}): boolean {
  const expected = normalizeAccountId(params.expectedAccountId);
  const actual = normalizeAccountId(params.actualAccountId);
  return !expected || !actual || expected === actual;
}

function modeIncludesSession(mode: "session" | "targets" | "both" | undefined): boolean {
  return mode === undefined || mode === "session" || mode === "both";
}

function modeIncludesTargets(mode: "session" | "targets" | "both" | undefined): boolean {
  return mode === "targets" || mode === "both";
}

function hasSlackPluginForwardingTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const targets = resolvePluginApprovalForwardingConfig(params.cfg)?.targets ?? [];
  return targets.some((target) => {
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    return (
      channel === "slack" &&
      matchesSlackAccount({
        expectedAccountId: params.accountId,
        actualAccountId: target.accountId,
      })
    );
  });
}

function requestHasSlackOriginOrSession(params: {
  request: SlackNativeApprovalRequest;
  accountId?: string | null;
}): boolean {
  const request = params.request.request;
  const turnSourceChannel = normalizeMessageChannel(request.turnSourceChannel);
  if (turnSourceChannel) {
    return (
      turnSourceChannel === "slack" &&
      matchesSlackAccount({
        expectedAccountId: params.accountId,
        actualAccountId: request.turnSourceAccountId,
      })
    );
  }
  return (
    resolveApprovalRequestSessionConversation({
      request: params.request,
      channel: "slack",
      bundledFallback: false,
    }) !== null
  );
}

function isPluginForwardingEnabledForRequest(params: {
  cfg: OpenClawConfig;
  request: SlackNativeApprovalRequest;
}): boolean {
  const config = resolvePluginApprovalForwardingConfig(params.cfg);
  if (!config?.enabled) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
  });
}

function canPluginForwardingRouteToSlack(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  const config = resolvePluginApprovalForwardingConfig(params.cfg);
  const mode = config?.mode;
  if (
    modeIncludesSession(mode) &&
    requestHasSlackOriginOrSession({
      request: params.request,
      accountId: params.accountId,
    })
  ) {
    return true;
  }
  return modeIncludesTargets(mode) && hasSlackPluginForwardingTarget(params);
}

function isSlackPluginNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const slackNativeConfig = resolveSlackNativeApprovalConfig(params);
  if (
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: slackNativeConfig?.enabled,
      approverCount: getSlackApprovalApprovers(params).length,
    })
  ) {
    return true;
  }
  const config = resolvePluginApprovalForwardingConfig(params.cfg);
  if (!config?.enabled || getSlackApprovalApprovers(params).length <= 0) {
    return false;
  }
  const mode = config.mode;
  return (
    modeIncludesSession(mode) ||
    (modeIncludesTargets(mode) && hasSlackPluginForwardingTarget(params))
  );
}

function shouldHandleSlackPluginViaNativeClientConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "slack",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  const config = resolveSlackNativeApprovalConfig(params);
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getSlackApprovalApprovers(params).length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}

function shouldHandleSlackPluginNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  if (getSlackApprovalApprovers(params).length <= 0) {
    return false;
  }
  if (shouldHandleSlackPluginViaNativeClientConfig(params)) {
    return true;
  }
  if (!isPluginForwardingEnabledForRequest(params)) {
    return false;
  }
  return canPluginForwardingRouteToSlack(params);
}

export function isSlackNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: SlackApprovalKind;
}): boolean {
  if (params.approvalKind === "exec") {
    return isSlackExecApprovalClientEnabled(params);
  }
  return isSlackPluginNativeApprovalClientEnabled(params);
}

export function isSlackAnyNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isSlackNativeApprovalClientEnabled({
      ...params,
      approvalKind: "exec",
    }) ||
    isSlackNativeApprovalClientEnabled({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function shouldHandleSlackNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: SlackApprovalKind;
  request: SlackNativeApprovalRequest;
}): boolean {
  const approvalKind = params.approvalKind ?? resolveSlackApprovalKind(params.request);
  if (approvalKind === "plugin") {
    return shouldHandleSlackPluginNativeApprovalRequest({
      cfg: params.cfg,
      accountId: params.accountId,
      request: params.request,
    });
  }
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "slack",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  const config = resolveSlackNativeApprovalConfig(params);
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getSlackNativeApprovalApprovers({
        ...params,
        approvalKind,
      }).length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}
