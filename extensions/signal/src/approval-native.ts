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
  createNativeApprovalForwardingFallbackSuppressor,
  doesApprovalRequestMatchChannelAccount,
  nativeApprovalTargetsMatch,
  resolveApprovalRequestSessionTarget,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPendingContentForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
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
    return nativeApprovalTargetsMatch({
      channel: "signal",
      left: configuredTarget,
      right: candidateTarget,
    });
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
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isTransportEnabled: isSignalApprovalTransportEnabled,
    isSessionRouteEligible: ({ cfg, accountId, metadata }) => {
      if (getSignalApprovalApprovers({ cfg, accountId }).length > 0) {
        return true;
      }
      const sessionTarget = resolveSignalSessionTargetFromSessionKey(metadata.sessionKey);
      return Boolean(sessionTarget && !isSignalGroupTarget(sessionTarget));
    },
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

const shouldSuppressSignalForwardingFallback =
  createNativeApprovalForwardingFallbackSuppressor<SignalApprovalTarget>({
    channel: "signal",
    normalizeForwardTarget: normalizeSignalForwardTarget,
    resolveAccountId: ({ forwardingTarget, request }) =>
      forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
    resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
      ...forwardingTarget,
      accountId,
    }),
    isSessionRouteEligible: isSignalSessionApprovalEligible,
    resolveOriginTarget: resolveSignalOriginTarget,
    resolveApproverDmTargets: resolveSignalApproverDmTargets,
  });

function buildSignalExecPendingPayload(params: { request: ExecApprovalRequest; nowMs: number }) {
  return buildApprovalReactionPendingContentForRequest(params).manualFallbackPayload;
}

function buildSignalPluginPendingPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  return buildApprovalReactionPendingContentForRequest(params).manualFallbackPayload;
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
    shouldSuppressForwardingFallback: shouldSuppressSignalForwardingFallback,
  },
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildSignalExecPendingPayload({
          request,
          nowMs,
        }),
    },
    plugin: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildSignalPluginPendingPayload({
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
