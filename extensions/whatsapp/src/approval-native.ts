import {
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApprovalForwardingEvaluator,
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalForwardingFallbackSuppressor,
  nativeApprovalTargetsMatch,
  resolveApprovalRequestSessionTarget,
} from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPromptPayloadForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "./accounts.js";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { isWhatsAppGroupJid, normalizeWhatsAppMessagingTarget } from "./normalize.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ChannelApprovalForwardTarget = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0]["target"];
type WhatsAppApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

function isWhatsAppApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

function targetAccountMatchesWhatsAppAccount(params: {
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
  const defaultAccountId = normalizeAccountId(resolveDefaultWhatsAppAccountId(params.cfg));
  if (normalizedAccountId === defaultAccountId) {
    return true;
  }
  const enabledAccountIds = listWhatsAppAccountIds(params.cfg)
    .filter((candidateAccountId) =>
      isWhatsAppApprovalTransportEnabled({
        cfg: params.cfg,
        accountId: candidateAccountId,
      }),
    )
    .map((candidateAccountId) => normalizeAccountId(candidateAccountId));
  return enabledAccountIds.length === 1 && enabledAccountIds[0] === normalizedAccountId;
}

function normalizeWhatsAppForwardTarget(
  target: Pick<ChannelApprovalForwardTarget, "channel" | "to" | "accountId" | "threadId">,
): WhatsAppApprovalTarget | null {
  if (normalizeLowercaseStringOrEmpty(target.channel) !== "whatsapp") {
    return null;
  }
  const to = normalizeWhatsAppMessagingTarget(target.to);
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: target.threadId ?? null,
  };
}

function hasMatchingWhatsAppTarget(params: {
  cfg: OpenClawConfig;
  config: ApprovalForwardingConfig;
  accountId?: string | null;
  target?: ChannelApprovalForwardTarget;
}): boolean {
  const candidateTarget = params.target ? normalizeWhatsAppForwardTarget(params.target) : null;
  return (params.config.targets ?? []).some((target) => {
    const configuredTarget = normalizeWhatsAppForwardTarget(target);
    if (!configuredTarget) {
      return false;
    }
    if (
      !targetAccountMatchesWhatsAppAccount({
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
      channel: "whatsapp",
      left: configuredTarget,
      right: candidateTarget,
    });
  });
}

function hasWhatsAppOriginOrSessionTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (resolveTurnSourceWhatsAppOriginTarget(params.request)) {
    return true;
  }

  const sessionTarget = resolveApprovalRequestSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  return (
    normalizeLowercaseStringOrEmpty(sessionTarget?.channel) === "whatsapp" &&
    targetAccountMatchesWhatsAppAccount({
      cfg: params.cfg,
      targetAccountId: sessionTarget?.accountId,
      accountId: params.accountId,
    })
  );
}

const whatsappApprovalForwarding = createChannelApprovalForwardingEvaluator({
  channel: "whatsapp",
  isTransportEnabled: isWhatsAppApprovalTransportEnabled,
  hasMatchingTarget: hasMatchingWhatsAppTarget,
  hasOriginOrSessionTarget: hasWhatsAppOriginOrSessionTarget,
});

const canApprovalPotentiallyRouteToWhatsApp = whatsappApprovalForwarding.isPotentialRoute;
const canAnyApprovalPotentiallyRouteToWhatsApp = whatsappApprovalForwarding.canAnyPotentiallyRoute;
const isWhatsAppSessionApprovalEligible = whatsappApprovalForwarding.isSessionEligible;
const isWhatsAppExplicitTargetEligible = whatsappApprovalForwarding.isExplicitTargetEligible;

function resolveTurnSourceWhatsAppOriginTarget(
  request: ApprovalRequest,
): WhatsAppApprovalTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  if (turnSourceChannel !== "whatsapp") {
    return null;
  }
  const to = normalizeWhatsAppMessagingTarget(request.request.turnSourceTo ?? "");
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(request.request.turnSourceAccountId),
  };
}

function resolveSessionWhatsAppOriginTarget(sessionTarget: {
  to: string;
  accountId?: string | null;
}): WhatsAppApprovalTarget | null {
  const to = normalizeWhatsAppMessagingTarget(sessionTarget.to);
  return to ? { to, accountId: normalizeOptionalString(sessionTarget.accountId) } : null;
}

function shouldHandleWhatsAppApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  return whatsappApprovalForwarding.shouldHandleRequest(params);
}

const resolveWhatsAppOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "whatsapp",
  shouldHandleRequest: shouldHandleWhatsAppApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceWhatsAppOriginTarget,
  resolveSessionTarget: resolveSessionWhatsAppOriginTarget,
  normalizeTarget: (target) => {
    const to = normalizeWhatsAppMessagingTarget(target.to);
    return to ? { ...target, to } : null;
  },
});

function resolveWhatsAppOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: "exec" | "plugin";
  request: ApprovalRequest;
}): WhatsAppApprovalTarget | null {
  const target = resolveWhatsAppOriginTargetBase(params);
  if (!target) {
    return null;
  }
  if (
    isWhatsAppGroupJid(target.to) &&
    getWhatsAppApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0
  ) {
    return null;
  }
  return target;
}

const resolveWhatsAppApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleWhatsAppApprovalRequest,
  resolveApprovers: getWhatsAppApprovalApprovers,
  mapApprover: (approver, params) => {
    const to = normalizeWhatsAppMessagingTarget(approver);
    if (!to) {
      return null;
    }
    return {
      to,
      accountId: normalizeOptionalString(params.accountId),
    };
  },
});

const shouldSuppressWhatsAppForwardingFallback =
  createNativeApprovalForwardingFallbackSuppressor<WhatsAppApprovalTarget>({
    channel: "whatsapp",
    normalizeForwardTarget: normalizeWhatsAppForwardTarget,
    resolveAccountId: ({ forwardingTarget, request }) =>
      forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
    resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
      ...forwardingTarget,
      accountId,
    }),
    isSessionRouteEligible: isWhatsAppSessionApprovalEligible,
    isExplicitTargetEligible: isWhatsAppExplicitTargetEligible,
    resolveOriginTarget: resolveWhatsAppOriginTarget,
    resolveApproverDmTargets: resolveWhatsAppApproverDmTargets,
  });

function buildWhatsAppExecPendingPayload(params: { request: ExecApprovalRequest; nowMs: number }) {
  return buildApprovalReactionPromptPayloadForRequest(params);
}

function buildWhatsAppPluginPendingPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  return buildApprovalReactionPromptPayloadForRequest(params);
}

export const whatsappApprovalCapability: ChannelApprovalCapability =
  createChannelApprovalCapability({
    ...whatsappApprovalAuth,
    getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
      (
        approvalKind
          ? canApprovalPotentiallyRouteToWhatsApp({ cfg, accountId, approvalKind })
          : canAnyApprovalPotentiallyRouteToWhatsApp({ cfg, accountId })
      )
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      canApprovalPotentiallyRouteToWhatsApp({ cfg, accountId, approvalKind: "exec" })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.whatsapp.accounts.${accountId}`
          : "channels.whatsapp";
      return `WhatsApp supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows WhatsApp. Link WhatsApp and keep the gateway running; configure \`${prefix}.allowFrom\` to restrict approvers.`;
    },
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        listWhatsAppAccountIds(cfg).some((accountId) => {
          if (
            !canAnyApprovalPotentiallyRouteToWhatsApp({
              cfg,
              accountId,
              nativeSessionOnly: true,
            })
          ) {
            return false;
          }
          return getWhatsAppApprovalApprovers({ cfg, accountId }).length > 0;
        }),
      shouldSuppressForwardingFallback: shouldSuppressWhatsAppForwardingFallback,
    },
    render: {
      exec: {
        buildPendingPayload: ({ request, nowMs }) =>
          buildWhatsAppExecPendingPayload({ request, nowMs }),
      },
      plugin: {
        buildPendingPayload: ({ request, nowMs }) =>
          buildWhatsAppPluginPendingPayload({ request, nowMs }),
      },
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId, approvalKind, request }) => {
        const originTarget = resolveWhatsAppOriginTarget({
          cfg,
          accountId,
          approvalKind,
          request,
        });
        const approverTargets = resolveWhatsAppApproverDmTargets({
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
      resolveOriginTarget: resolveWhatsAppOriginTarget,
      resolveApproverDmTargets: resolveWhatsAppApproverDmTargets,
    },
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) &&
        canAnyApprovalPotentiallyRouteToWhatsApp({
          cfg,
          accountId,
          nativeSessionOnly: true,
        }),
      shouldHandle: ({ cfg, accountId, context, request }) =>
        Boolean(context) && shouldHandleWhatsAppApprovalRequest({ cfg, accountId, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .whatsappApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });

export const whatsappNativeApprovalAdapter = splitChannelApprovalCapability(
  whatsappApprovalCapability,
);
