// Signal plugin module implements approval native behavior.
import {
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPendingContentForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
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

const signalApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "signal",
  defaultForwardingMode: DEFAULT_APPROVAL_FORWARDING_MODE,
  isTransportEnabled: isSignalApprovalTransportEnabled,
  listAccountIds: listSignalAccountIds,
  resolveDefaultAccountId: resolveDefaultSignalAccountId,
  normalizeForwardTarget: normalizeSignalForwardTarget,
  resolveTurnSourceTarget: resolveTurnSourceSignalOriginTarget,
});

const {
  canApprovalPotentiallyRouteToChannel: canApprovalPotentiallyRouteToSignal,
  canAnyApprovalPotentiallyRouteToChannel: canAnyApprovalPotentiallyRouteToSignal,
  isNativeApprovalHandlerConfigured: isSignalNativeApprovalHandlerConfiguredBase,
  isSessionApprovalEligible: isSignalSessionApprovalEligible,
  shouldHandleApprovalRequest: shouldHandleSignalApprovalRequest,
} = signalApprovalRouteGates;

export function isSignalNativeApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return isSignalNativeApprovalHandlerConfiguredBase(params);
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
