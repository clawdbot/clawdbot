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
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;
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

const DEFAULT_APPROVAL_FORWARDING_MODE: ApprovalForwardingMode = "session";
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

function nativeApprovalTargetsMatch(params: {
  left: IMessageApprovalTarget;
  right: IMessageApprovalTarget;
}): boolean {
  return channelRouteTargetsMatchExact({
    left: {
      channel: "imessage",
      to: params.left.to,
      accountId: params.left.accountId,
      threadId: params.left.threadId,
    },
    right: {
      channel: "imessage",
      to: params.right.to,
      accountId: params.right.accountId,
      threadId: params.right.threadId,
    },
  });
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
    return nativeApprovalTargetsMatch({ left: configuredTarget, right: candidateTarget });
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

function canApprovalPotentiallyRouteToIMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  nativeSessionOnly?: boolean;
}): boolean {
  if (!isIMessageApprovalTransportEnabled(params)) {
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
    hasMatchingIMessageTarget({
      cfg: params.cfg,
      config,
      accountId: params.accountId,
    })
  );
}

function canAnyApprovalPotentiallyRouteToIMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  nativeSessionOnly?: boolean;
}): boolean {
  return (
    canApprovalPotentiallyRouteToIMessage({
      ...params,
      approvalKind: "exec",
    }) ||
    canApprovalPotentiallyRouteToIMessage({
      ...params,
      approvalKind: "plugin",
    })
  );
}

function isIMessageSessionApprovalEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  if (!isIMessageApprovalTransportEnabled(params)) {
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
      channel: "imessage",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  return hasIMessageOriginOrSessionTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request,
  });
}

function isIMessageExplicitTargetEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
  target: ChannelApprovalForwardTarget;
}): boolean {
  if (!isIMessageApprovalTransportEnabled(params)) {
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
  return hasMatchingIMessageTarget({
    cfg: params.cfg,
    config,
    accountId: params.accountId,
    target: params.target,
  });
}

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

function shouldHandleIMessageApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
}): boolean {
  return isIMessageSessionApprovalEligible({
    ...params,
    approvalKind: resolveApprovalKind(params.request, params.approvalKind),
  });
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
      shouldSuppressForwardingFallback: ({ cfg, approvalKind, target, request }) => {
        const forwardingTarget = normalizeIMessageForwardTarget(target);
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
            ? isIMessageExplicitTargetEligible({
                cfg,
                accountId,
                approvalKind: kind,
                request,
                target,
              })
            : isIMessageSessionApprovalEligible({
                cfg,
                accountId,
                approvalKind: kind,
                request,
              });
        if (!eligible) {
          return false;
        }
        const originTarget = resolveIMessageOriginTarget({
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
        return resolveIMessageApproverDmTargets({
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
