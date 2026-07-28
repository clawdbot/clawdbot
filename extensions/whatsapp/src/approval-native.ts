// Whatsapp plugin module implements approval native behavior.
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalMessagingTargetResolvers,
} from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPromptPayloadForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import { buildTypedApprovalPresentation } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "./accounts.js";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { isWhatsAppGroupJid, normalizeWhatsAppMessagingTarget } from "./normalize.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;

const DEFAULT_APPROVAL_FORWARDING_MODE: ApprovalForwardingMode = "session";
const whatsappApprovalTargetResolvers = createNativeApprovalMessagingTargetResolvers({
  channel: "whatsapp",
  normalizeTo: normalizeWhatsAppMessagingTarget,
});
type WhatsAppApprovalTarget = NonNullable<
  ReturnType<typeof whatsappApprovalTargetResolvers.normalizeForwardTarget>
>;
const {
  normalizeForwardTarget: normalizeWhatsAppForwardTarget,
  normalizeTarget: normalizeWhatsAppApprovalTarget,
  resolveSessionTarget: resolveSessionWhatsAppOriginTarget,
  resolveTurnSourceTarget: resolveTurnSourceWhatsAppOriginTarget,
} = whatsappApprovalTargetResolvers;

function isWhatsAppApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

const whatsappApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "whatsapp",
  defaultForwardingMode: DEFAULT_APPROVAL_FORWARDING_MODE,
  isTransportEnabled: isWhatsAppApprovalTransportEnabled,
  listAccountIds: listWhatsAppAccountIds,
  resolveDefaultAccountId: resolveDefaultWhatsAppAccountId,
  normalizeForwardTarget: normalizeWhatsAppForwardTarget,
  resolveTurnSourceTarget: resolveTurnSourceWhatsAppOriginTarget,
});

const {
  canApprovalPotentiallyRouteToChannel: canApprovalPotentiallyRouteToWhatsApp,
  canAnyApprovalPotentiallyRouteToChannel: canAnyApprovalPotentiallyRouteToWhatsApp,
  isSessionApprovalEligible: isWhatsAppSessionApprovalEligible,
  isExplicitTargetEligible: isWhatsAppExplicitTargetEligible,
  shouldHandleApprovalRequest: shouldHandleWhatsAppApprovalRequest,
} = whatsappApprovalRouteGates;

const resolveWhatsAppOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "whatsapp",
  shouldHandleRequest: shouldHandleWhatsAppApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceWhatsAppOriginTarget,
  resolveSessionTarget: resolveSessionWhatsAppOriginTarget,
  normalizeTarget: normalizeWhatsAppApprovalTarget,
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
  const payload = buildApprovalReactionPromptPayloadForRequest(params);
  return {
    ...payload,
    presentation: buildTypedApprovalPresentation({
      approvalId: params.request.id,
      approvalKind: "exec",
      allowedDecisions: payload.allowedDecisions,
    }),
  };
}

function buildWhatsAppPluginPendingPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  const payload = buildApprovalReactionPromptPayloadForRequest(params);
  return {
    ...payload,
    presentation: buildTypedApprovalPresentation({
      approvalId: params.request.id,
      approvalKind: "plugin",
      allowedDecisions: payload.allowedDecisions,
    }),
  };
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
      shouldHandle: ({ cfg, accountId, context, approvalKind, request }) =>
        Boolean(context) &&
        shouldHandleWhatsAppApprovalRequest({ cfg, accountId, approvalKind, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .whatsappApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });
