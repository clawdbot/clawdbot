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
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalReplyDecision,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { channelRouteTargetsMatchExact } from "openclaw/plugin-sdk/channel-route";
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
import { addWhatsAppApprovalReactionHintToText } from "./approval-reactions.js";
import { isWhatsAppGroupJid, normalizeWhatsAppMessagingTarget } from "./normalize.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;
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

const DEFAULT_APPROVAL_FORWARDING_MODE: ApprovalForwardingMode = "session";
const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ExecApprovalReplyDecision[] = [
  "allow-once",
  "allow-always",
  "deny",
];

function isWhatsAppApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
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

function nativeApprovalTargetsMatch(params: {
  left: WhatsAppApprovalTarget;
  right: WhatsAppApprovalTarget;
}): boolean {
  return channelRouteTargetsMatchExact({
    left: {
      channel: "whatsapp",
      to: params.left.to,
      accountId: params.left.accountId,
      threadId: params.left.threadId,
    },
    right: {
      channel: "whatsapp",
      to: params.right.to,
      accountId: params.right.accountId,
      threadId: params.right.threadId,
    },
  });
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
    return nativeApprovalTargetsMatch({ left: configuredTarget, right: candidateTarget });
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

function canApprovalPotentiallyRouteToWhatsApp(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  nativeSessionOnly?: boolean;
}): boolean {
  if (!isWhatsAppApprovalTransportEnabled(params)) {
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
    hasMatchingWhatsAppTarget({
      cfg: params.cfg,
      config,
      accountId: params.accountId,
    })
  );
}

function canAnyApprovalPotentiallyRouteToWhatsApp(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  nativeSessionOnly?: boolean;
}): boolean {
  return (
    canApprovalPotentiallyRouteToWhatsApp({
      ...params,
      approvalKind: "exec",
    }) ||
    canApprovalPotentiallyRouteToWhatsApp({
      ...params,
      approvalKind: "plugin",
    })
  );
}

function isWhatsAppSessionApprovalEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  if (!isWhatsAppApprovalTransportEnabled(params)) {
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
      channel: "whatsapp",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  return hasWhatsAppOriginOrSessionTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request,
  });
}

function isWhatsAppExplicitTargetEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
  target: ChannelApprovalForwardTarget;
}): boolean {
  if (!isWhatsAppApprovalTransportEnabled(params)) {
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
  return hasMatchingWhatsAppTarget({
    cfg: params.cfg,
    config,
    accountId: params.accountId,
    target: params.target,
  });
}

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
  return isWhatsAppSessionApprovalEligible({
    ...params,
    approvalKind: resolveApprovalKind(params.request, params.approvalKind),
  });
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

function appendWhatsAppReactionHint(params: {
  text?: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  return addWhatsAppApprovalReactionHintToText({
    text: params.text ?? "",
    allowedDecisions: params.allowedDecisions,
  });
}

function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${approvalId}`);
}

function buildWhatsAppExecPendingPayload(params: { request: ExecApprovalRequest; nowMs: number }) {
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
    text: appendWhatsAppReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
  };
}

function buildWhatsAppPluginPendingPayload(params: {
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
    text: appendWhatsAppReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
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
      shouldSuppressForwardingFallback: ({ cfg, approvalKind, target, request }) => {
        const forwardingTarget = normalizeWhatsAppForwardTarget(target);
        if (!forwardingTarget) {
          return false;
        }
        const accountId =
          forwardingTarget.accountId ??
          normalizeOptionalString(request.request.turnSourceAccountId);
        const forwardingTargetForMatch = {
          ...forwardingTarget,
          accountId,
        };
        const kind = resolveApprovalKind(request, approvalKind);
        const eligible =
          target.source === "target"
            ? isWhatsAppExplicitTargetEligible({
                cfg,
                accountId,
                approvalKind: kind,
                request,
                target,
              })
            : isWhatsAppSessionApprovalEligible({
                cfg,
                accountId,
                approvalKind: kind,
                request,
              });
        if (!eligible) {
          return false;
        }
        const originTarget = resolveWhatsAppOriginTarget({
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
        return resolveWhatsAppApproverDmTargets({
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
