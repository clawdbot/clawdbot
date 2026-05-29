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
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalReplyDecision,
  PluginApprovalRequest,
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
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import { addIMessageApprovalReactionHintToText } from "./approval-reactions.js";
import { replaceApprovalIdPlaceholder } from "./approval-text.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { inferIMessageTargetChatType } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ChannelApprovalForwardTarget = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0]["target"];
type IMessageApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ExecApprovalReplyDecision[] = [
  "allow-once",
  "allow-always",
  "deny",
];

function isIMessageApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

function targetAccountMatchesIMessageAccount(params: {
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
  const defaultAccountId = normalizeAccountId(resolveDefaultIMessageAccountId(params.cfg));
  if (normalizedAccountId === defaultAccountId) {
    return true;
  }
  const enabledAccountIds = listIMessageAccountIds(params.cfg)
    .filter((candidateAccountId) =>
      isIMessageApprovalTransportEnabled({
        cfg: params.cfg,
        accountId: candidateAccountId,
      }),
    )
    .map((candidateAccountId) => normalizeAccountId(candidateAccountId));
  return enabledAccountIds.length === 1 && enabledAccountIds[0] === normalizedAccountId;
}

function normalizeIMessageForwardTarget(
  target: Pick<ChannelApprovalForwardTarget, "channel" | "to" | "accountId" | "threadId">,
): IMessageApprovalTarget | null {
  if (normalizeLowercaseStringOrEmpty(target.channel) !== "imessage") {
    return null;
  }
  const to = normalizeIMessageMessagingTarget(target.to);
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: target.threadId ?? null,
  };
}

function hasMatchingIMessageTarget(params: {
  cfg: OpenClawConfig;
  config: ApprovalForwardingConfig;
  accountId?: string | null;
  target?: ChannelApprovalForwardTarget;
}): boolean {
  const candidateTarget = params.target ? normalizeIMessageForwardTarget(params.target) : null;
  return (params.config.targets ?? []).some((target) => {
    const configuredTarget = normalizeIMessageForwardTarget(target);
    if (!configuredTarget) {
      return false;
    }
    if (
      !targetAccountMatchesIMessageAccount({
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
      channel: "imessage",
      left: configuredTarget,
      right: candidateTarget,
    });
  });
}

function hasIMessageOriginOrSessionTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (resolveTurnSourceIMessageOriginTarget(params.request)) {
    return true;
  }

  const sessionTarget = resolveApprovalRequestSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  return (
    normalizeLowercaseStringOrEmpty(sessionTarget?.channel) === "imessage" &&
    targetAccountMatchesIMessageAccount({
      cfg: params.cfg,
      targetAccountId: sessionTarget?.accountId,
      accountId: params.accountId,
    })
  );
}

const imessageApprovalForwarding = createChannelApprovalForwardingEvaluator({
  channel: "imessage",
  isTransportEnabled: isIMessageApprovalTransportEnabled,
  hasMatchingTarget: hasMatchingIMessageTarget,
  hasOriginOrSessionTarget: hasIMessageOriginOrSessionTarget,
});

const canApprovalPotentiallyRouteToIMessage = imessageApprovalForwarding.isPotentialRoute;
const canAnyApprovalPotentiallyRouteToIMessage = imessageApprovalForwarding.canAnyPotentiallyRoute;
const isIMessageSessionApprovalEligible = imessageApprovalForwarding.isSessionEligible;
const isIMessageExplicitTargetEligible = imessageApprovalForwarding.isExplicitTargetEligible;

function resolveTurnSourceIMessageOriginTarget(
  request: ApprovalRequest,
): IMessageApprovalTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  if (turnSourceChannel !== "imessage") {
    return null;
  }
  const to = normalizeIMessageMessagingTarget(request.request.turnSourceTo ?? "");
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(request.request.turnSourceAccountId),
  };
}

function resolveSessionIMessageOriginTarget(sessionTarget: {
  to: string;
  accountId?: string | null;
}): IMessageApprovalTarget | null {
  const to = normalizeIMessageMessagingTarget(sessionTarget.to);
  return to ? { to, accountId: normalizeOptionalString(sessionTarget.accountId) } : null;
}

function resolveIMessageSessionTargetFromSessionKey(
  sessionKey?: string | null,
): IMessageApprovalTarget | null {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? normalizeOptionalString(sessionKey);
  if (!rest || !normalizeLowercaseStringOrEmpty(rest).startsWith("imessage:")) {
    return null;
  }
  const route = rest.slice("imessage:".length).trim();
  const routeLower = normalizeLowercaseStringOrEmpty(route);
  if (
    !route ||
    routeLower.startsWith("group:") ||
    routeLower.startsWith("channel:") ||
    routeLower.startsWith("chat:")
  ) {
    return null;
  }

  const directPrefix = "direct:";
  if (routeLower.startsWith(directPrefix)) {
    const to = normalizeIMessageMessagingTarget(route.slice(directPrefix.length));
    return to ? { to } : null;
  }

  const accountScopedDirect = /^([^:]+):direct:(.+)$/i.exec(route);
  if (accountScopedDirect) {
    const to = normalizeIMessageMessagingTarget(accountScopedDirect[2] ?? "");
    return to ? { to, accountId: normalizeAccountId(accountScopedDirect[1] ?? "") } : null;
  }

  const to = normalizeIMessageMessagingTarget(route);
  if (!to || inferIMessageTargetChatType(to) !== "direct") {
    return null;
  }
  return { to };
}

export function shouldSuppressLocalIMessageExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  if (
    shouldSuppressLocalNativeExecApprovalPrompt({
      ...params,
      isTransportEnabled: isIMessageApprovalTransportEnabled,
      isSessionRouteEligible: ({ cfg, accountId, metadata }) => {
        if (getIMessageApprovalApprovers({ cfg, accountId }).length > 0) {
          return true;
        }
        const sessionTarget = resolveIMessageSessionTargetFromSessionKey(metadata.sessionKey);
        if (!sessionTarget || inferIMessageTargetChatType(sessionTarget.to) !== "direct") {
          return false;
        }
        const targetAccountId = normalizeOptionalString(sessionTarget.accountId);
        return (
          !targetAccountId ||
          !accountId ||
          normalizeAccountId(targetAccountId) === normalizeAccountId(accountId)
        );
      },
    })
  ) {
    return true;
  }

  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (
    params.hint?.kind !== "approval-pending" ||
    params.hint.approvalKind !== "exec" ||
    params.hint.nativeRouteActive !== true ||
    metadata?.approvalKind !== "exec"
  ) {
    return false;
  }

  // The Pi tool-result path currently rebuilds the local approval prompt from
  // exec result details that omit agentId/sessionKey. The native iMessage
  // approval runtime has already received the full request and will deliver the
  // reaction prompt. When explicit iMessage approvers exist, keep the local
  // fallback from sending a second manual prompt for the same approval.
  if (metadata.agentId || metadata.sessionKey) {
    return false;
  }
  if (getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0) {
    return false;
  }
  return canApprovalPotentiallyRouteToIMessage({
    ...params,
    approvalKind: "exec",
    nativeSessionOnly: true,
  });
}

function shouldHandleIMessageApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  return imessageApprovalForwarding.shouldHandleRequest(params);
}

const resolveIMessageOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "imessage",
  shouldHandleRequest: shouldHandleIMessageApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceIMessageOriginTarget,
  resolveSessionTarget: resolveSessionIMessageOriginTarget,
  normalizeTarget: (target) => {
    const to = normalizeIMessageMessagingTarget(target.to);
    return to ? { ...target, to } : null;
  },
});

function resolveIMessageOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: "exec" | "plugin";
  request: ApprovalRequest;
}): IMessageApprovalTarget | null {
  const target = resolveIMessageOriginTargetBase(params);
  if (!target) {
    return null;
  }
  // Group conversations need explicit approvers configured before we route an
  // approval prompt into them; otherwise any group member could approve.
  if (
    inferIMessageTargetChatType(target.to) === "group" &&
    getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0
  ) {
    return null;
  }
  return target;
}

const resolveIMessageApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleIMessageApprovalRequest,
  resolveApprovers: getIMessageApprovalApprovers,
  mapApprover: (approver, params) => {
    const to = normalizeIMessageMessagingTarget(approver);
    if (!to) {
      return null;
    }
    return {
      to,
      accountId: normalizeOptionalString(params.accountId),
    };
  },
});

const shouldSuppressIMessageForwardingFallback =
  createNativeApprovalForwardingFallbackSuppressor<IMessageApprovalTarget>({
    channel: "imessage",
    normalizeForwardTarget: normalizeIMessageForwardTarget,
    resolveAccountId: ({ forwardingTarget, request }) =>
      forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
    resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
      ...forwardingTarget,
      accountId,
    }),
    isSessionRouteEligible: isIMessageSessionApprovalEligible,
    isExplicitTargetEligible: isIMessageExplicitTargetEligible,
    resolveOriginTarget: resolveIMessageOriginTarget,
    resolveApproverDmTargets: resolveIMessageApproverDmTargets,
  });

function appendIMessageReactionHint(params: {
  text?: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  return addIMessageApprovalReactionHintToText({
    text: params.text ?? "",
    allowedDecisions: params.allowedDecisions,
  });
}

function buildIMessageExecPendingPayload(params: { request: ExecApprovalRequest; nowMs: number }) {
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
    text: appendIMessageReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
  };
}

function buildIMessagePluginPendingPayload(params: {
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
    text: appendIMessageReactionHint({
      text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
      allowedDecisions,
    }),
  };
}

export const imessageApprovalCapability: ChannelApprovalCapability =
  createChannelApprovalCapability({
    ...imessageApprovalAuth,
    getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
      (
        approvalKind
          ? canApprovalPotentiallyRouteToIMessage({ cfg, accountId, approvalKind })
          : canAnyApprovalPotentiallyRouteToIMessage({ cfg, accountId })
      )
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      canApprovalPotentiallyRouteToIMessage({ cfg, accountId, approvalKind: "exec" })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.imessage.accounts.${accountId}`
          : "channels.imessage";
      return `iMessage supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows iMessage. Keep the macOS imsg bridge running and configure \`${prefix}.allowFrom\` to restrict approvers.`;
    },
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        listIMessageAccountIds(cfg).some((accountId) => {
          if (
            !canAnyApprovalPotentiallyRouteToIMessage({
              cfg,
              accountId,
              nativeSessionOnly: true,
            })
          ) {
            return false;
          }
          return getIMessageApprovalApprovers({ cfg, accountId }).length > 0;
        }),
      shouldSuppressForwardingFallback: shouldSuppressIMessageForwardingFallback,
    },
    render: {
      exec: {
        buildPendingPayload: ({ request, nowMs }) =>
          buildIMessageExecPendingPayload({ request, nowMs }),
      },
      plugin: {
        buildPendingPayload: ({ request, nowMs }) =>
          buildIMessagePluginPendingPayload({ request, nowMs }),
      },
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId, approvalKind, request }) => {
        const originTarget = resolveIMessageOriginTarget({
          cfg,
          accountId,
          approvalKind,
          request,
        });
        const approverTargets = resolveIMessageApproverDmTargets({
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
      resolveOriginTarget: resolveIMessageOriginTarget,
      resolveApproverDmTargets: resolveIMessageApproverDmTargets,
    },
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) &&
        canAnyApprovalPotentiallyRouteToIMessage({
          cfg,
          accountId,
          nativeSessionOnly: true,
        }),
      shouldHandle: ({ cfg, accountId, context, request }) =>
        Boolean(context) && shouldHandleIMessageApprovalRequest({ cfg, accountId, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .imessageApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });

export const imessageNativeApprovalAdapter = splitChannelApprovalCapability(
  imessageApprovalCapability,
);
