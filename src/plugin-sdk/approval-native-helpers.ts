import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import { resolveApprovalRequestOriginTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import { channelRouteTargetsMatchExact } from "./channel-route.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";

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
