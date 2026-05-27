import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import { resolveApprovalRequestOriginTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { ChannelApprovalCapability, ChannelOutboundPayloadHint } from "./channel-contract.js";
import { channelRouteTargetsMatchExact } from "./channel-route.js";
import type { OpenClawConfig } from "./config-runtime.js";
import type { ReplyPayload } from "./reply-payload.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type DeliverySuppressionInput = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0];
type NativeApprovalForwardTarget = DeliverySuppressionInput["target"];
type LocalNativeExecApprovalConfig = {
  enabled?: boolean | "auto";
  mode?: string | null;
  agentFilter?: string[];
  sessionFilter?: string[];
};

type ApprovalResolverParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
};

type NativeApprovalTargetNormalizer<TTarget> = (
  target: TTarget,
  request: ApprovalRequest,
) => TTarget | null | undefined;

type NativeApprovalForwardingFallbackSuppressorParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  normalizeForwardTarget: (target: NativeApprovalForwardTarget) => TTarget | null;
  resolveAccountId?: (params: {
    forwardingTarget: TTarget;
    target: NativeApprovalForwardTarget;
    request: ApprovalRequest;
  }) => string | null | undefined;
  resolveApprovalKind?: (params: {
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }) => ApprovalKind;
  isSessionRouteEligible: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => boolean;
  isExplicitTargetEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
    target: NativeApprovalForwardTarget;
  }) => boolean;
  resolveForwardingTargetForMatch?: (params: {
    forwardingTarget: TTarget;
    accountId?: string | null;
    target: NativeApprovalForwardTarget;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => TTarget | null;
  resolveOriginTarget: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => TTarget | null;
  resolveApproverDmTargets: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => readonly TTarget[];
  targetsMatch?: (left: TTarget, right: TTarget) => boolean;
};

type NativeOriginResolverParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  targetsMatch?: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

type CustomOriginResolverParams<TTarget> = {
  channel: string;
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

export type NativeApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export function nativeApprovalTargetsMatch(params: {
  channel?: string | null;
  left: NativeApprovalTarget;
  right: NativeApprovalTarget;
}): boolean {
  return channelRouteTargetsMatchExact({
    left: {
      channel: params.channel,
      to: params.left.to,
      accountId: params.left.accountId,
      threadId: params.left.threadId,
    },
    right: {
      channel: params.channel,
      to: params.right.to,
      accountId: params.right.accountId,
      threadId: params.right.threadId,
    },
  });
}

export function shouldSuppressLocalNativeExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
  isTransportEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  isNativeDeliveryEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  resolveApprovalConfig?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => LocalNativeExecApprovalConfig | undefined;
  requireApprovalConfigEnabled?: boolean;
  enforceForwardingMode?: boolean;
  isSessionRouteEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => boolean;
  hasExactTargetProof?: boolean;
  fallbackAgentIdFromSessionKey?: boolean;
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
  const isDeliveryEnabled = params.isNativeDeliveryEnabled ?? params.isTransportEnabled;
  if (!isDeliveryEnabled?.({ cfg: params.cfg, accountId: params.accountId })) {
    return false;
  }
  const config =
    params.resolveApprovalConfig?.({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    }) ?? params.cfg.approvals?.exec;
  const requireConfigEnabled =
    params.requireApprovalConfigEnabled ?? params.resolveApprovalConfig === undefined;
  if (requireConfigEnabled && !config?.enabled) {
    return false;
  }
  const enforceForwardingMode =
    params.enforceForwardingMode ?? params.resolveApprovalConfig === undefined;
  if (enforceForwardingMode) {
    const mode = config?.mode ?? "session";
    if (mode !== "session" && mode !== "both" && !params.hasExactTargetProof) {
      return false;
    }
  }
  if (
    params.isSessionRouteEligible &&
    !params.isSessionRouteEligible({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: {
      agentId: metadata.agentId,
      sessionKey: metadata.sessionKey,
    },
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
    fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey ?? true,
  });
}

function isNativeApprovalTarget(value: unknown): value is NativeApprovalTarget {
  return Boolean(
    value && typeof value === "object" && typeof (value as { to?: unknown }).to === "string",
  );
}

function nativeApprovalTargetMatcher(channel: string): (left: unknown, right: unknown) => boolean {
  return (left, right) =>
    isNativeApprovalTarget(left) &&
    isNativeApprovalTarget(right) &&
    nativeApprovalTargetsMatch({ channel, left, right });
}

function resolveApprovalKind(request: ApprovalRequest, approvalKind?: ApprovalKind): ApprovalKind {
  if (approvalKind) {
    return approvalKind;
  }
  return "command" in request.request ? "exec" : "plugin";
}

function normalizeOptionalAccountId(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

export function createNativeApprovalForwardingFallbackSuppressor<
  TTarget extends NativeApprovalTarget,
>(
  params: NativeApprovalForwardingFallbackSuppressorParams<TTarget>,
): NonNullable<
  NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
> {
  const targetsMatch =
    params.targetsMatch ??
    ((left: TTarget, right: TTarget) =>
      nativeApprovalTargetsMatch({ channel: params.channel, left, right }));

  return (input: DeliverySuppressionInput): boolean => {
    const forwardingTarget = params.normalizeForwardTarget(input.target);
    if (!forwardingTarget) {
      return false;
    }
    const accountId =
      normalizeOptionalAccountId(
        params.resolveAccountId?.({
          forwardingTarget,
          target: input.target,
          request: input.request,
        }),
      ) ??
      normalizeOptionalAccountId(forwardingTarget.accountId) ??
      normalizeOptionalAccountId(input.request.request.turnSourceAccountId);
    const approvalKind =
      params.resolveApprovalKind?.({
        approvalKind: input.approvalKind,
        request: input.request,
      }) ?? resolveApprovalKind(input.request, input.approvalKind);
    const explicitTarget = input.target.source === "target";
    const eligible = explicitTarget
      ? (params.isExplicitTargetEligible?.({
          cfg: input.cfg,
          accountId,
          approvalKind,
          request: input.request,
          target: input.target,
        }) ?? false)
      : params.isSessionRouteEligible({
          cfg: input.cfg,
          accountId,
          approvalKind,
          request: input.request,
        });
    if (!eligible) {
      return false;
    }

    const forwardingTargetForMatch =
      params.resolveForwardingTargetForMatch?.({
        forwardingTarget,
        accountId,
        target: input.target,
        approvalKind,
        request: input.request,
      }) ?? forwardingTarget;
    if (!forwardingTargetForMatch) {
      return false;
    }
    const originTarget = params.resolveOriginTarget({
      cfg: input.cfg,
      accountId,
      approvalKind,
      request: input.request,
    });
    if (originTarget && targetsMatch(forwardingTargetForMatch, originTarget)) {
      return true;
    }
    return params
      .resolveApproverDmTargets({
        cfg: input.cfg,
        accountId,
        approvalKind,
        request: input.request,
      })
      .some((approverTarget) => targetsMatch(forwardingTargetForMatch, approverTarget));
  };
}

function createOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null {
  return (input: ApprovalResolverParams): TTarget | null => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return null;
    }
    const normalizeTarget = (target: TTarget | null): TTarget | null => {
      if (!target) {
        return null;
      }
      return params.normalizeTarget
        ? (params.normalizeTarget(target, input.request) ?? null)
        : target;
    };
    const normalizeTargetForMatch = (target: TTarget): TTarget | null =>
      params.normalizeTargetForMatch?.(target, input.request) ?? target;
    return resolveApprovalRequestOriginTarget({
      cfg: input.cfg,
      request: input.request,
      channel: params.channel,
      accountId: input.accountId,
      resolveTurnSourceTarget: (request) =>
        normalizeTarget(params.resolveTurnSourceTarget(request)),
      resolveSessionTarget: (sessionTarget) =>
        normalizeTarget(params.resolveSessionTarget(sessionTarget, input.request)),
      targetsMatch: (left, right) => {
        const normalizedLeft = normalizeTargetForMatch(left);
        const normalizedRight = normalizeTargetForMatch(right);
        return Boolean(
          normalizedLeft && normalizedRight && params.targetsMatch(normalizedLeft, normalizedRight),
        );
      },
      resolveFallbackTarget: params.resolveFallbackTarget
        ? (request) => normalizeTarget(params.resolveFallbackTarget?.(request) ?? null)
        : undefined,
    });
  };
}

function hasCustomTargetsMatch<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): params is CustomOriginResolverParams<TTarget> {
  return typeof params.targetsMatch === "function";
}

export function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(
  params: NativeOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => NativeApprovalTarget | TTarget | null {
  if (hasCustomTargetsMatch(params)) {
    return createOriginTargetResolver(params);
  }
  return createOriginTargetResolver({
    ...params,
    targetsMatch: nativeApprovalTargetMatcher(params.channel),
  });
}

export function createChannelApproverDmTargetResolver<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}) {
  return (input: ApprovalResolverParams): TTarget[] => {
    if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) {
      return [];
    }
    const targets: TTarget[] = [];
    for (const approver of params.resolveApprovers({
      cfg: input.cfg,
      accountId: input.accountId,
    })) {
      const target = params.mapApprover(approver, input);
      if (target) {
        targets.push(target);
      }
    }
    return targets;
  };
}
