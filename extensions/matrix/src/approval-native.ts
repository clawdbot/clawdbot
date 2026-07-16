import {
  createChannelApprovalCapability,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { getMatrixApprovalAuthApprovers, matrixApprovalAuth } from "./approval-auth.js";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import {
  getMatrixApprovalApprovers,
  getMatrixExecApprovalApprovers,
  isMatrixAnyApprovalClientEnabled,
  isMatrixApprovalClientEnabled,
  isMatrixExecApprovalClientEnabled,
  isMatrixExecApprovalAuthorizedSender,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixApprovalRequest,
} from "./exec-approvals.js";
import { listMatrixAccountIds } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type MatrixOriginTarget = { to: string; threadId?: string };

function normalizeComparableTarget(value: string): string {
  const target = resolveMatrixTargetIdentity(value);
  if (!target) {
    return normalizeLowercaseStringOrEmpty(value);
  }
  if (target.kind === "user") {
    return `user:${normalizeMatrixUserId(target.id)}`;
  }
  return `${normalizeLowercaseStringOrEmpty(target.kind)}:${target.id}`;
}

function resolveMatrixNativeTarget(raw: string): string | null {
  const target = resolveMatrixTargetIdentity(raw);
  if (!target) {
    return null;
  }
  return target.kind === "user" ? `user:${target.id}` : `room:${target.id}`;
}

function resolveTurnSourceMatrixOriginTarget(request: ApprovalRequest): MatrixOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = request.request.turnSourceTo?.trim() || "";
  const target = resolveMatrixNativeTarget(turnSourceTo);
  if (turnSourceChannel !== "matrix" || !target) {
    return null;
  }
  return {
    to: target,
    threadId: normalizeOptionalStringifiedId(request.request.turnSourceThreadId),
  };
}

function resolveSessionMatrixOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): MatrixOriginTarget | null {
  const target = resolveMatrixNativeTarget(sessionTarget.to);
  if (!target) {
    return null;
  }
  return {
    to: target,
    threadId: normalizeOptionalStringifiedId(sessionTarget.threadId),
  };
}

function matrixTargetsMatch(a: MatrixOriginTarget, b: MatrixOriginTarget): boolean {
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    (a.threadId ?? "") === (b.threadId ?? "")
  );
}

function hasMatrixPluginApprovers(params: { cfg: CoreConfig; accountId?: string | null }): boolean {
  return getMatrixApprovalAuthApprovers(params).length > 0;
}

function availabilityState(enabled: boolean) {
  return enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
}

function hasMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): boolean {
  return (
    getMatrixApprovalApprovers({
      cfg: params.cfg,
      accountId: params.accountId,
      approvalKind: params.approvalKind,
    }).length > 0
  );
}

function hasAnyMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): boolean {
  return (
    getMatrixExecApprovalApprovers(params).length > 0 ||
    getMatrixApprovalAuthApprovers(params).length > 0
  );
}

function isMatrixPluginAuthorizedSender(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const normalizedSenderId = params.senderId
    ? normalizeMatrixApproverId(params.senderId)
    : undefined;
  if (!normalizedSenderId) {
    return false;
  }
  return getMatrixApprovalAuthApprovers(params).includes(normalizedSenderId);
}

function resolveSuppressionAccountId(params: {
  target: { accountId?: string | null };
  request: { request: { turnSourceAccountId?: string | null } };
}): string | undefined {
  return (
    params.target.accountId?.trim() ||
    params.request.request.turnSourceAccountId?.trim() ||
    undefined
  );
}

const resolveMatrixOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "matrix",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMatrixApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceMatrixOriginTarget,
  resolveSessionTarget: resolveSessionMatrixOriginTarget,
  targetsMatch: matrixTargetsMatch,
  resolveFallbackTarget: (request) => {
    const sessionConversation = resolveApprovalRequestSessionConversation({
      request,
      channel: "matrix",
    });
    if (!sessionConversation) {
      return null;
    }
    const target = resolveMatrixNativeTarget(sessionConversation.id);
    if (!target) {
      return null;
    }
    return {
      to: target,
      threadId: normalizeOptionalStringifiedId(sessionConversation.threadId),
    };
  },
});

function resolveMatrixApproverDmTargets(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): { to: string }[] {
  if (!shouldHandleMatrixApprovalRequest(params)) {
    return [];
  }
  return getMatrixApprovalApprovers(params)
    .map((approver) => {
      const normalized = normalizeMatrixUserId(approver);
      return normalized ? { to: `user:${normalized}` } : null;
    })
    .filter((target): target is { to: string } => target !== null);
}

const matrixNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "matrix",
  channelLabel: "Matrix",
  describeExecApprovalSetup: ({
    accountId,
  }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.matrix.accounts.${accountId}`
        : "channels.matrix";
    return `Approve it from the Web UI or terminal UI for now. Matrix supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`${prefix}.dm.allowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  listAccountIds: listMatrixAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    hasAnyMatrixApprovalApprovers({
      cfg: cfg as CoreConfig,
      accountId,
    }),
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixPluginAuthorizedSender({
      cfg: cfg as CoreConfig,
      accountId,
      senderId,
    }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isMatrixExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveMatrixExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId,
  resolveOriginTarget: resolveMatrixOriginTarget,
  resolveApproverDmTargets: resolveMatrixApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isMatrixAnyApprovalClientEnabled({
        cfg,
        accountId,
      }),
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleMatrixApprovalRequest({
        cfg,
        accountId,
        request,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .matrixApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
});

const splitMatrixApprovalCapability = splitChannelApprovalCapability(
  matrixNativeApprovalCapability,
);
const matrixBaseNativeApprovalAdapter = splitMatrixApprovalCapability.native;
const matrixBaseDeliveryAdapter = splitMatrixApprovalCapability.delivery;
type MatrixForwardingSuppressionParams = Parameters<
  NonNullable<NonNullable<typeof matrixBaseDeliveryAdapter>["shouldSuppressForwardingFallback"]>
>[0];
const matrixDeliveryAdapter = matrixBaseDeliveryAdapter && {
  ...matrixBaseDeliveryAdapter,
  shouldSuppressForwardingFallback: (params: MatrixForwardingSuppressionParams) => {
    const accountId = resolveSuppressionAccountId(params);
    if (
      !hasMatrixApprovalApprovers({
        cfg: params.cfg as CoreConfig,
        accountId,
        approvalKind: params.approvalKind,
      })
    ) {
      return false;
    }
    return matrixBaseDeliveryAdapter.shouldSuppressForwardingFallback?.(params) ?? false;
  },
};
const matrixNativeAdapter = matrixBaseNativeApprovalAdapter && {
  describeDeliveryCapabilities: (
    params: Parameters<typeof matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities>[0],
  ) => {
    const capabilities = matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities(params);
    const hasApprovers = hasMatrixApprovalApprovers({
      cfg: params.cfg as CoreConfig,
      accountId: params.accountId,
      approvalKind: params.approvalKind,
    });
    const clientEnabled = isMatrixApprovalClientEnabled({
      cfg: params.cfg,
      accountId: params.accountId,
      approvalKind: params.approvalKind,
    });
    return {
      ...capabilities,
      enabled: capabilities.enabled && hasApprovers && clientEnabled,
    };
  },
  resolveOriginTarget: matrixBaseNativeApprovalAdapter.resolveOriginTarget,
  resolveApproverDmTargets: matrixBaseNativeApprovalAdapter.resolveApproverDmTargets,
};

export const matrixApprovalCapability = createChannelApprovalCapability({
  authorizeActorAction: (
    params: Parameters<NonNullable<ChannelApprovalCapability["authorizeActorAction"]>>[0],
  ) => {
    if (params.approvalKind !== "plugin") {
      return matrixNativeApprovalCapability.authorizeActorAction?.(params) ?? { authorized: true };
    }
    if (
      !hasMatrixPluginApprovers({
        cfg: params.cfg as CoreConfig,
        accountId: params.accountId,
      })
    ) {
      return {
        authorized: false,
        reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
      } as const;
    }
    return matrixApprovalAuth.authorizeActorAction(params);
  },
  getActionAvailabilityState: (
    params: Parameters<NonNullable<ChannelApprovalCapability["getActionAvailabilityState"]>>[0],
  ) => {
    if (params.approvalKind === "plugin") {
      return availabilityState(
        hasMatrixPluginApprovers({
          cfg: params.cfg as CoreConfig,
          accountId: params.accountId,
        }),
      );
    }
    return (
      matrixNativeApprovalCapability.getActionAvailabilityState?.(params) ?? {
        kind: "disabled",
      }
    );
  },
  getExecInitiatingSurfaceState: (
    params: Parameters<NonNullable<ChannelApprovalCapability["getExecInitiatingSurfaceState"]>>[0],
  ) =>
    matrixNativeApprovalCapability.getExecInitiatingSurfaceState?.(params) ??
    ({ kind: "disabled" } as const),
  describeExecApprovalSetup: matrixNativeApprovalCapability.describeExecApprovalSetup,
  delivery: matrixDeliveryAdapter,
  nativeRuntime: matrixNativeApprovalCapability.nativeRuntime,
  native: matrixNativeAdapter,
  render: matrixNativeApprovalCapability.render,
});
