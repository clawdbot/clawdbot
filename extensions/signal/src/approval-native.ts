import { matchesApprovalRequestFilters } from "openclaw/plugin-sdk/approval-client-runtime";
import {
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestSessionTarget,
} from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ExecApprovalReplyDecision,
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import { channelRouteTargetsMatchExact } from "openclaw/plugin-sdk/channel-route";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;
type ChannelApprovalForwardTarget = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0]["target"];
type SignalApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const DEFAULT_APPROVAL_FORWARDING_MODE: ApprovalForwardingMode = "session";
const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ExecApprovalReplyDecision[] = [
  "allow-once",
  "allow-always",
  "deny",
];

function isSignalApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

function resolveApprovalKind(request: ApprovalRequest, approvalKind?: ApprovalKind): ApprovalKind {
  if (approvalKind) {
    return approvalKind;
  }
  return "command" in request.request ? "exec" : "plugin";
}

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ApprovalForwardingConfig["mode"] | undefined,
): ApprovalForwardingMode {
  return mode ?? DEFAULT_APPROVAL_FORWARDING_MODE;
}

function approvalModeIncludesSession(mode: ApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function approvalModeIncludesTargets(mode: ApprovalForwardingMode): boolean {
  return mode === "targets" || mode === "both";
}

function matchesForwardingFilters(params: {
  config: ApprovalForwardingConfig;
  request: ApprovalRequest;
}): boolean {
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function targetAccountMatchesSignalAccount(params: {
  cfg: OpenClawConfig;
  targetAccountId?: string | null;
  accountId?: string | null;
}): boolean {
  const targetAccountId = normalizeOptionalString(params.targetAccountId);
  const accountId = normalizeOptionalString(params.accountId);
  if (targetAccountId) {
    return !accountId || normalizeAccountId(targetAccountId) === normalizeAccountId(accountId);
  }
  if (!accountId) {
    return true;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const defaultAccountId = normalizeAccountId(resolveDefaultSignalAccountId(params.cfg));
  if (normalizedAccountId === defaultAccountId) {
    return true;
  }
  const enabledAccountIds = listSignalAccountIds(params.cfg)
    .filter((candidateAccountId) =>
      isSignalApprovalTransportEnabled({
        cfg: params.cfg,
        accountId: candidateAccountId,
      }),
    )
    .map((candidateAccountId) => normalizeAccountId(candidateAccountId));
  return enabledAccountIds.length === 1 && enabledAccountIds[0] === normalizedAccountId;
}

function normalizeSignalForwardTarget(
  target: Pick<ChannelApprovalForwardTarget, "channel" | "to" | "accountId" | "threadId">,
): SignalApprovalTarget | null {
  if (normalizeLowercaseStringOrEmpty(target.channel) !== "signal") {
    return null;
  }
  const to = normalizeSignalMessagingTarget(target.to);
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: target.threadId ?? null,
  };
}

function nativeApprovalTargetsMatch(params: {
  left: SignalApprovalTarget;
  right: SignalApprovalTarget;
}): boolean {
  return channelRouteTargetsMatchExact({
    left: {
      channel: "signal",
      to: params.left.to,
      accountId: params.left.accountId,
      threadId: params.left.threadId,
    },
    right: {
      channel: "signal",
      to: params.right.to,
      accountId: params.right.accountId,
      threadId: params.right.threadId,
    },
  });
}

function hasMatchingSignalTarget(params: {
  cfg: OpenClawConfig;
  config: ApprovalForwardingConfig;
  accountId?: string | null;
  target?: ChannelApprovalForwardTarget;
}): boolean {
  const candidateTarget = params.target ? normalizeSignalForwardTarget(params.target) : null;
  return (params.config.targets ?? []).some((target) => {
    const configuredTarget = normalizeSignalForwardTarget(target);
    if (!configuredTarget) {
      return false;
    }
    if (
      !targetAccountMatchesSignalAccount({
        cfg: params.cfg,
        targetAccountId: configuredTarget.accountId,
        accountId: params.accountId,
      })
    ) {
      return false;
    }
    if (!candidateTarget) {
      return true;
    }
    return nativeApprovalTargetsMatch({ left: configuredTarget, right: candidateTarget });
  });
}

function hasSignalOriginOrSessionTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (resolveTurnSourceSignalOriginTarget(params.request)) {
    return true;
  }

  const sessionTarget = resolveApprovalRequestSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  return (
    normalizeLowercaseStringOrEmpty(sessionTarget?.channel) === "signal" &&
    targetAccountMatchesSignalAccount({
      cfg: params.cfg,
      targetAccountId: sessionTarget?.accountId,
      accountId: params.accountId,
    })
  );
}

function canApprovalPotentiallyRouteToSignal(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  nativeSessionOnly?: boolean;
}): boolean {
  if (!isSignalApprovalTransportEnabled(params)) {
    return false;
  }
  const config = resolveApprovalForwardingConfig(params);
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (approvalModeIncludesSession(mode)) {
    return true;
  }
  if (params.nativeSessionOnly) {
    return false;
  }
  return (
    approvalModeIncludesTargets(mode) &&
    hasMatchingSignalTarget({
      cfg: params.cfg,
      config,
      accountId: params.accountId,
    })
  );
}

function canAnyApprovalPotentiallyRouteToSignal(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  nativeSessionOnly?: boolean;
}): boolean {
  return (
    canApprovalPotentiallyRouteToSignal({
      ...params,
      approvalKind: "exec",
    }) ||
    canApprovalPotentiallyRouteToSignal({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function isSignalNativeApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return canAnyApprovalPotentiallyRouteToSignal({
    ...params,
    nativeSessionOnly: true,
  });
}

function isSignalSessionApprovalEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  if (!isSignalApprovalTransportEnabled(params)) {
    return false;
  }
  const config = resolveApprovalForwardingConfig(params);
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (!approvalModeIncludesSession(mode)) {
    return false;
  }
  if (!matchesForwardingFilters({ config, request: params.request })) {
    return false;
  }
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "signal",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  return hasSignalOriginOrSessionTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request,
  });
}

function isSignalExplicitTargetEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
  target: ChannelApprovalForwardTarget;
}): boolean {
  if (!isSignalApprovalTransportEnabled(params)) {
    return false;
  }
  const config = resolveApprovalForwardingConfig(params);
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (!approvalModeIncludesTargets(mode)) {
    return false;
  }
  if (!matchesForwardingFilters({ config, request: params.request })) {
    return false;
  }
  return hasMatchingSignalTarget({
    cfg: params.cfg,
    config,
    accountId: params.accountId,
    target: params.target,
  });
}

function resolveTurnSourceSignalOriginTarget(
  request: ApprovalRequest,
): SignalApprovalTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  if (turnSourceChannel !== "signal") {
    return null;
  }
  const to = normalizeSignalMessagingTarget(request.request.turnSourceTo ?? "");
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(request.request.turnSourceAccountId),
  };
}

function resolveSessionSignalOriginTarget(sessionTarget: {
  to: string;
  accountId?: string | null;
}): SignalApprovalTarget | null {
  const to = normalizeSignalMessagingTarget(sessionTarget.to);
  return to ? { to, accountId: normalizeOptionalString(sessionTarget.accountId) } : null;
}

function shouldHandleSignalApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  return isSignalSessionApprovalEligible({
    ...params,
    approvalKind: resolveApprovalKind(params.request, params.approvalKind),
  });
}

function resolveSignalSessionTargetFromSessionKey(sessionKey?: string | null): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? normalizeOptionalString(sessionKey);
  if (!rest || !normalizeLowercaseStringOrEmpty(rest).startsWith("signal:")) {
    return null;
  }
  return normalizeSignalMessagingTarget(rest.slice("signal:".length)) ?? null;
}

export function shouldSuppressLocalSignalExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  if (params.hint?.kind !== "approval-pending" || params.hint.approvalKind !== "exec") {
    return false;
  }
  if (params.hint.nativeRouteActive !== true) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata || metadata.approvalKind !== "exec") {
    return false;
  }
  if (!isSignalApprovalTransportEnabled(params)) {
    return false;
  }
  const config = resolveApprovalForwardingConfig({
    cfg: params.cfg,
    approvalKind: "exec",
  });
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (!approvalModeIncludesSession(mode)) {
    return false;
  }
  if (getSignalApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0) {
    const sessionTarget = resolveSignalSessionTargetFromSessionKey(metadata.sessionKey);
    if (!sessionTarget || isSignalGroupTarget(sessionTarget)) {
      return false;
    }
  }
  return matchesApprovalRequestFilters({
    request: {
      agentId: metadata.agentId,
      sessionKey: metadata.sessionKey,
    },
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

const resolveSignalOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "signal",
  shouldHandleRequest: shouldHandleSignalApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceSignalOriginTarget,
  resolveSessionTarget: resolveSessionSignalOriginTarget,
  normalizeTarget: (target) => {
    const to = normalizeSignalMessagingTarget(target.to);
    return to ? { ...target, to } : null;
  },
});

function isSignalGroupTarget(to: string): boolean {
  return normalizeLowercaseStringOrEmpty(to).startsWith("group:");
}

function resolveSignalOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}): SignalApprovalTarget | null {
  const target = resolveSignalOriginTargetBase(params);
  if (!target) {
    return null;
  }
  if (
    isSignalGroupTarget(target.to) &&
    getSignalApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0
  ) {
    return null;
  }
  return target;
}

const resolveSignalApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleSignalApprovalRequest,
  resolveApprovers: getSignalApprovalApprovers,
  mapApprover: (approver, params) => {
    const to = normalizeSignalMessagingTarget(approver);
    if (!to) {
      return null;
    }
    return {
      to,
      accountId: normalizeOptionalString(params.accountId),
    };
  },
});

function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${approvalId}`);
}

function buildSignalExecPendingPayload(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest;
  nowMs: number;
}) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(params.request.request);
  const command = resolveExecApprovalCommandDisplay(params.request.request).commandText;
  const payload = buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    warningText: params.request.request.warningText ?? undefined,
    ask: params.request.request.ask ?? null,
    agentId: params.request.request.agentId ?? null,
    allowedDecisions,
    command,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    sessionKey: params.request.request.sessionKey ?? null,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
  return {
    ...payload,
    text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
  };
}

function buildSignalPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  const configuredDecisions = params.request.request.allowedDecisions;
  const allowedDecisions =
    configuredDecisions && configuredDecisions.length > 0
      ? configuredDecisions
      : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
  const payload = buildPluginApprovalPendingReplyPayload({
    request: params.request,
    nowMs: params.nowMs,
    allowedDecisions,
  });
  return {
    ...payload,
    text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
  };
}

export const signalApprovalCapability: ChannelApprovalCapability = createChannelApprovalCapability({
  ...signalApprovalAuth,
  getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
    (
      approvalKind
        ? canApprovalPotentiallyRouteToSignal({ cfg, accountId, approvalKind })
        : canAnyApprovalPotentiallyRouteToSignal({ cfg, accountId })
    )
      ? ({ kind: "enabled" } as const)
      : ({ kind: "disabled" } as const),
  getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
    canApprovalPotentiallyRouteToSignal({ cfg, accountId, approvalKind: "exec" })
      ? ({ kind: "enabled" } as const)
      : ({ kind: "disabled" } as const),
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.signal.accounts.${accountId}`
        : "channels.signal";
    return `Signal supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows Signal. Link Signal and keep the gateway running; configure \`${prefix}.allowFrom\` to restrict approvers.`;
  },
  delivery: {
    hasConfiguredDmRoute: ({ cfg }) =>
      listSignalAccountIds(cfg).some((accountId) => {
        if (
          !canAnyApprovalPotentiallyRouteToSignal({
            cfg,
            accountId,
            nativeSessionOnly: true,
          })
        ) {
          return false;
        }
        return getSignalApprovalApprovers({ cfg, accountId }).length > 0;
      }),
    shouldSuppressForwardingFallback: ({ cfg, approvalKind, target, request }) => {
      const forwardingTarget = normalizeSignalForwardTarget(target);
      if (!forwardingTarget) {
        return false;
      }
      const accountId =
        forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId);
      const forwardingTargetForMatch = {
        ...forwardingTarget,
        accountId: target.source === "target" ? forwardingTarget.accountId : accountId,
      };
      const kind = resolveApprovalKind(request, approvalKind);
      const eligible =
        target.source === "target"
          ? isSignalExplicitTargetEligible({
              cfg,
              accountId,
              approvalKind: kind,
              request,
              target,
            })
          : isSignalSessionApprovalEligible({
              cfg,
              accountId,
              approvalKind: kind,
              request,
            });
      if (!eligible) {
        return false;
      }
      if (target.source === "target") {
        return false;
      }
      const originTarget = resolveSignalOriginTarget({
        cfg,
        accountId,
        approvalKind: kind,
        request,
      });
      if (
        originTarget &&
        nativeApprovalTargetsMatch({ left: forwardingTargetForMatch, right: originTarget })
      ) {
        return true;
      }
      return resolveSignalApproverDmTargets({
        cfg,
        accountId,
        approvalKind: kind,
        request,
      }).some((approverTarget) =>
        nativeApprovalTargetsMatch({ left: forwardingTargetForMatch, right: approverTarget }),
      );
    },
  },
  render: {
    exec: {
      buildPendingPayload: ({ cfg, request, target, nowMs }) =>
        buildSignalExecPendingPayload({
          cfg,
          accountId: target.accountId,
          request,
          nowMs,
        }),
    },
    plugin: {
      buildPendingPayload: ({ cfg, request, target, nowMs }) =>
        buildSignalPluginPendingPayload({
          cfg,
          accountId: target.accountId,
          request,
          nowMs,
        }),
    },
  },
  native: {
    describeDeliveryCapabilities: ({ cfg, accountId, approvalKind, request }) => {
      const originTarget = resolveSignalOriginTarget({
        cfg,
        accountId,
        approvalKind,
        request,
      });
      const approverTargets = resolveSignalApproverDmTargets({
        cfg,
        accountId,
        approvalKind,
        request,
      });
      const enabled = Boolean(originTarget) || approverTargets.length > 0;
      return {
        enabled,
        preferredSurface: originTarget ? "origin" : "approver-dm",
        supportsOriginSurface: Boolean(originTarget),
        supportsApproverDmSurface: approverTargets.length > 0,
        notifyOriginWhenDmOnly: true,
      };
    },
    resolveOriginTarget: resolveSignalOriginTarget,
    resolveApproverDmTargets: resolveSignalApproverDmTargets,
  },
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId, context }) =>
      Boolean(context) &&
      isSignalNativeApprovalHandlerConfigured({
        cfg,
        accountId,
      }),
    shouldHandle: ({ cfg, accountId, context, request }) =>
      Boolean(context) && shouldHandleSignalApprovalRequest({ cfg, accountId, request }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .signalApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
});

export const signalNativeApprovalAdapter = splitChannelApprovalCapability(signalApprovalCapability);
