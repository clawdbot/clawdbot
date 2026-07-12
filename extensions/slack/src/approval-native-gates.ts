// Slack plugin module implements approval native gates behavior.
import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import {
  createNativeApprovalChannelRouteGates,
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
} from "openclaw/plugin-sdk/channel-route";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "./accounts.js";
import { getSlackApprovalApprovers } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalClientEnabled,
} from "./exec-approvals.js";
import { canonicalizeSlackApiTargetId, parseSlackTarget } from "./target-parsing.js";

export type SlackApprovalKind = "exec" | "plugin";
export type SlackNativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export type SlackOriginTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["plugin"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;
type SlackForwardTarget = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0]["target"];

const DEFAULT_APPROVAL_FORWARDING_MODE: ApprovalForwardingMode = "session";
const SLACK_DM_CHANNEL_ID_RE = /^D[A-Z0-9]{8,}$/i;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/i;

export function resolveSlackApprovalKind(request: SlackNativeApprovalRequest): SlackApprovalKind {
  const isExec = "command" in request.request;
  const isPlugin = "title" in request.request && "description" in request.request;
  if (isExec === isPlugin) {
    throw new Error("Slack approval request payload does not identify exactly one owner");
  }
  return isExec ? "exec" : "plugin";
}

function isSlackApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveSlackAccount(params);
  return account.config.enterpriseOrgInstall !== true && isSlackPluginAccountConfigured(account);
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

function normalizeSlackThreadMatchKey(threadId?: string | number | null): string {
  return threadId == null ? "" : String(threadId).trim();
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function extractSlackSessionKind(
  sessionKey?: string | null,
): "direct" | "channel" | "group" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/slack:(direct|channel|group):/i);
  const kind = normalizeLowercaseStringOrEmpty(match?.[1]);
  return kind ? (kind as "direct" | "channel" | "group") : null;
}

function resolveSlackTurnSourceDefaultKind(params: {
  turnSourceTo: string;
  sessionKind: "direct" | "channel" | "group" | null;
}): "user" | "channel" {
  // Slack app conversations arrive as the concrete D-channel plus the app
  // thread root, so keep that live target instead of rewriting it to a user id.
  if (SLACK_DM_CHANNEL_ID_RE.test(params.turnSourceTo)) {
    return "channel";
  }
  return params.sessionKind === "direct" ? "user" : "channel";
}

export function resolveTurnSourceSlackOriginTarget(
  request: SlackNativeApprovalRequest,
): SlackOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: resolveSlackTurnSourceDefaultKind({ turnSourceTo, sessionKind }),
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId: stringifyRouteThreadId(request.request.turnSourceThreadId),
  };
}

export function resolveSessionSlackOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): SlackOriginTarget {
  return {
    to: sessionTarget.to,
    threadId: stringifyRouteThreadId(sessionTarget.threadId),
  };
}

export function resolveSlackFallbackOriginTarget(
  request: SlackNativeApprovalRequest,
): SlackOriginTarget | null {
  const sessionTarget = resolveApprovalRequestSessionConversation({
    request,
    channel: "slack",
    bundledFallback: false,
  });
  if (!sessionTarget) {
    return null;
  }
  const parsed = parseSlackTarget(sessionTarget.id, {
    defaultKind: "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${canonicalizeSlackApiTargetId(parsed.kind, parsed.id)}`,
    threadId: sessionTarget.threadId,
  };
}

export function normalizeSlackOriginTarget(target: SlackOriginTarget): SlackOriginTarget {
  return {
    ...target,
    to: normalizeComparableTarget(target.to),
  };
}

function parseComparableSlackTarget(target: SlackOriginTarget) {
  return parseSlackTarget(target.to, { defaultKind: "channel" });
}

function isSlackDmChannelToUserRoutePair(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const left = parseComparableSlackTarget(a);
  const right = parseComparableSlackTarget(b);
  if (!left || !right) {
    return false;
  }
  return (
    (left.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(left.id) && right.kind === "user") ||
    (right.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(right.id) && left.kind === "user")
  );
}

export function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const threadKey = normalizeSlackThreadMatchKey(a.threadId);
  if (threadKey !== normalizeSlackThreadMatchKey(b.threadId)) {
    return false;
  }
  if (
    channelRouteTargetsMatchExact({
      left: {
        channel: "slack",
        to: a.to,
      },
      right: {
        channel: "slack",
        to: b.to,
      },
    })
  ) {
    return true;
  }
  return Boolean(threadKey && isSlackDmChannelToUserRoutePair(a, b));
}

export function normalizeSlackForwardTarget(
  target: Pick<SlackForwardTarget, "channel" | "to" | "accountId" | "threadId">,
): SlackOriginTarget | null {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  if (channel !== "slack") {
    return null;
  }
  const to = normalizeOptionalString(target.to);
  if (!to) {
    return null;
  }
  const parsed = parseSlackTarget(to, {
    defaultKind: SLACK_USER_ID_RE.test(to) ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${parsed.id}`,
    accountId: normalizeOptionalString(target.accountId),
    threadId: stringifyRouteThreadId(target.threadId),
  };
}

const slackApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "slack",
  defaultForwardingMode: DEFAULT_APPROVAL_FORWARDING_MODE,
  isTransportEnabled: isSlackApprovalTransportEnabled,
  listAccountIds: listSlackAccountIds,
  resolveDefaultAccountId: resolveDefaultSlackAccountId,
  normalizeForwardTarget: normalizeSlackForwardTarget,
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
});

const {
  canApprovalPotentiallyRouteToChannel: canApprovalPotentiallyRouteToSlack,
  isSessionApprovalEligible: isForwardedSlackSessionApprovalEligible,
  isExplicitTargetEligible: isForwardedSlackExplicitTargetEligible,
} = slackApprovalRouteGates;

export function hasSlackPluginApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return getSlackApprovalApprovers(params).length > 0;
}

function isSlackPluginNativeApprovalClientConfigEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const slackNativeConfig = resolveSlackNativeApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: slackNativeConfig?.enabled,
    approverCount: getSlackApprovalApprovers(params).length,
  });
}

function isSlackPluginForwardingRoutePotentiallyEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return canApprovalPotentiallyRouteToSlack({
    ...params,
    approvalKind: "plugin",
  });
}

function isSlackPluginNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isSlackPluginNativeApprovalClientConfigEnabled(params) ||
    isSlackPluginForwardingRoutePotentiallyEnabled(params)
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
  return matchesSlackNativeApprovalFilters({
    request: params.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}

function matchesSlackNativeApprovalFilters(params: {
  request: SlackNativeApprovalRequest;
  agentFilter?: string[];
  sessionFilter?: string[];
}): boolean {
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: params.agentFilter,
    sessionFilter: params.sessionFilter,
  });
}

function isAnyForwardedSlackExplicitTargetEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  const targets = resolvePluginApprovalForwardingConfig(params.cfg)?.targets ?? [];
  return targets.some((target) =>
    isForwardedSlackExplicitTargetEligible({
      ...params,
      approvalKind: "plugin",
      target,
    }),
  );
}

function shouldHandleSlackPluginViaForwarding(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  return (
    isForwardedSlackSessionApprovalEligible({
      ...params,
      approvalKind: "plugin",
    }) || isAnyForwardedSlackExplicitTargetEligible(params)
  );
}

export function shouldHandleSlackPluginViaForwardingSession(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  return isForwardedSlackSessionApprovalEligible({
    ...params,
    approvalKind: "plugin",
  });
}

function isSlackNativeApprovalClientEnabled(params: {
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
    return (
      shouldHandleSlackPluginViaNativeClientConfig(params) ||
      shouldHandleSlackPluginViaForwarding(params)
    );
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
      approverCount: getSlackExecApprovalApprovers(params).length,
    })
  ) {
    return false;
  }
  return matchesSlackNativeApprovalFilters({
    request: params.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}
