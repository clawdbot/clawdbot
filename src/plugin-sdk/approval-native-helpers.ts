import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardingMode,
} from "../config/types.approvals.js";
import { doesApprovalRequestMatchChannelAccount } from "../infra/approval-request-account-binding.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import {
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestSessionTarget,
} from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
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
type ChannelApprovalForwardTarget = DeliverySuppressionInput["target"];

type ApprovalResolverParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
};

type ChannelApprovalForwardingEvaluatorParams = {
  channel: string;
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  hasMatchingTarget: (params: {
    cfg: OpenClawConfig;
    config: ExecApprovalForwardingConfig;
    accountId?: string | null;
    target?: ChannelApprovalForwardTarget;
  }) => boolean;
  hasOriginOrSessionTarget: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    request: ApprovalRequest;
  }) => boolean;
};

export type ChannelApprovalForwardingEligibilityParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
};

export type ChannelApprovalPotentialRouteParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  nativeSessionOnly?: boolean;
};

export type ChannelApprovalExplicitTargetEligibilityParams =
  ChannelApprovalForwardingEligibilityParams & {
    target: ChannelApprovalForwardTarget;
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

type NativeApprovalChannelRouteGateParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  defaultForwardingMode: ExecApprovalForwardingMode;
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  listAccountIds: (cfg: OpenClawConfig) => readonly string[];
  resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
  normalizeForwardTarget: (target: NativeApprovalForwardTarget) => TTarget | null;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  targetsMatch?: (left: TTarget, right: TTarget) => boolean;
};

type NativeApprovalChannelRouteGates = {
  canApprovalPotentiallyRouteToChannel: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    nativeSessionOnly?: boolean;
  }) => boolean;
  canAnyApprovalPotentiallyRouteToChannel: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }) => boolean;
  isNativeApprovalHandlerConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => boolean;
  isSessionApprovalEligible: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => boolean;
  isExplicitTargetEligible: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
    target: NativeApprovalForwardTarget;
  }) => boolean;
  shouldHandleApprovalRequest: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }) => boolean;
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

export function resolveApprovalKind(
  request: ApprovalRequest,
  approvalKind?: ApprovalKind,
): ApprovalKind {
  if (approvalKind) {
    return approvalKind;
  }
  return "command" in request.request ? "exec" : "plugin";
}

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ExecApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ExecApprovalForwardingConfig["mode"] | undefined,
): ExecApprovalForwardingMode {
  return mode ?? "session";
}

function approvalModeIncludesSession(mode: ExecApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function approvalModeIncludesTargets(mode: ExecApprovalForwardingMode): boolean {
  return mode === "targets" || mode === "both";
}

function matchesForwardingFilters(params: {
  config: ExecApprovalForwardingConfig;
  request: ApprovalRequest;
}): boolean {
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

export function createChannelApprovalForwardingEvaluator(
  params: ChannelApprovalForwardingEvaluatorParams,
) {
  const isPotentialRoute = (input: ChannelApprovalPotentialRouteParams): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (approvalModeIncludesSession(mode)) {
      return true;
    }
    if (input.nativeSessionOnly) {
      return false;
    }
    return (
      approvalModeIncludesTargets(mode) &&
      params.hasMatchingTarget({
        cfg: input.cfg,
        config,
        accountId: input.accountId,
      })
    );
  };

  const isSessionEligible = (input: ChannelApprovalForwardingEligibilityParams): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (!approvalModeIncludesSession(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    if (
      !doesApprovalRequestMatchChannelAccount({
        cfg: input.cfg,
        request: input.request,
        channel: params.channel,
        accountId: input.accountId,
      })
    ) {
      return false;
    }
    return params.hasOriginOrSessionTarget({
      cfg: input.cfg,
      accountId: input.accountId,
      request: input.request,
    });
  };

  const isExplicitTargetEligible = (
    input: ChannelApprovalExplicitTargetEligibilityParams,
  ): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (!approvalModeIncludesTargets(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    return params.hasMatchingTarget({
      cfg: input.cfg,
      config,
      accountId: input.accountId,
      target: input.target,
    });
  };

  const canAnyPotentiallyRoute = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }): boolean =>
    isPotentialRoute({
      ...input,
      approvalKind: "exec",
    }) ||
    isPotentialRoute({
      ...input,
      approvalKind: "plugin",
    });

  const shouldHandleRequest = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }): boolean =>
    isSessionEligible({
      ...input,
      approvalKind: resolveApprovalKind(input.request, input.approvalKind),
    });

  return {
    canAnyPotentiallyRoute,
    isExplicitTargetEligible,
    isPotentialRoute,
    isSessionEligible,
    shouldHandleRequest,
  };
}

function normalizeApprovalForwardingModeWithDefault(params: {
  config: ExecApprovalForwardingConfig;
  defaultForwardingMode: ExecApprovalForwardingMode;
}): ExecApprovalForwardingMode {
  return params.config.mode ?? params.defaultForwardingMode;
}

export function createNativeApprovalChannelRouteGates<TTarget extends NativeApprovalTarget>(
  params: NativeApprovalChannelRouteGateParams<TTarget>,
): NativeApprovalChannelRouteGates {
  const targetsMatch =
    params.targetsMatch ??
    ((left: TTarget, right: TTarget) =>
      nativeApprovalTargetsMatch({ channel: params.channel, left, right }));

  const targetAccountMatchesChannelAccount = (input: {
    cfg: OpenClawConfig;
    targetAccountId?: string | null;
    accountId?: string | null;
  }): boolean => {
    const targetAccountId = normalizeOptionalString(input.targetAccountId);
    const accountId = normalizeOptionalString(input.accountId);
    if (targetAccountId) {
      return !accountId || normalizeAccountId(targetAccountId) === normalizeAccountId(accountId);
    }
    if (!accountId) {
      return true;
    }
    const normalizedAccountId = normalizeAccountId(accountId);
    const defaultAccountId = normalizeAccountId(params.resolveDefaultAccountId(input.cfg));
    if (normalizedAccountId === defaultAccountId) {
      return true;
    }
    const enabledAccountIds = params
      .listAccountIds(input.cfg)
      .filter((candidateAccountId) =>
        params.isTransportEnabled({
          cfg: input.cfg,
          accountId: candidateAccountId,
        }),
      )
      .map((candidateAccountId) => normalizeAccountId(candidateAccountId));
    return enabledAccountIds.length === 1 && enabledAccountIds[0] === normalizedAccountId;
  };

  const hasMatchingChannelTarget = (input: {
    cfg: OpenClawConfig;
    config: ExecApprovalForwardingConfig;
    accountId?: string | null;
    target?: NativeApprovalForwardTarget;
  }): boolean => {
    const candidateTarget = input.target ? params.normalizeForwardTarget(input.target) : null;
    return (input.config.targets ?? []).some((target) => {
      const configuredTarget = params.normalizeForwardTarget(target);
      if (!configuredTarget) {
        return false;
      }
      if (
        !targetAccountMatchesChannelAccount({
          cfg: input.cfg,
          targetAccountId: configuredTarget.accountId,
          accountId: input.accountId,
        })
      ) {
        return false;
      }
      if (!candidateTarget) {
        return true;
      }
      return targetsMatch(configuredTarget, candidateTarget);
    });
  };

  const hasChannelOriginOrSessionTarget = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    request: ApprovalRequest;
  }): boolean => {
    if (params.resolveTurnSourceTarget(input.request)) {
      return true;
    }

    const sessionTarget = resolveApprovalRequestSessionTarget({
      cfg: input.cfg,
      request: input.request,
    });
    return (
      normalizeLowercaseStringOrEmpty(sessionTarget?.channel) === params.channel &&
      targetAccountMatchesChannelAccount({
        cfg: input.cfg,
        targetAccountId: sessionTarget?.accountId,
        accountId: input.accountId,
      })
    );
  };

  const canApprovalPotentiallyRouteToChannel = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    nativeSessionOnly?: boolean;
  }): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingModeWithDefault({
      config,
      defaultForwardingMode: params.defaultForwardingMode,
    });
    if (approvalModeIncludesSession(mode)) {
      return true;
    }
    if (input.nativeSessionOnly) {
      return false;
    }
    return (
      approvalModeIncludesTargets(mode) &&
      hasMatchingChannelTarget({
        cfg: input.cfg,
        config,
        accountId: input.accountId,
      })
    );
  };

  const canAnyApprovalPotentiallyRouteToChannel = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }): boolean =>
    canApprovalPotentiallyRouteToChannel({
      ...input,
      approvalKind: "exec",
    }) ||
    canApprovalPotentiallyRouteToChannel({
      ...input,
      approvalKind: "plugin",
    });

  const isSessionApprovalEligible = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingModeWithDefault({
      config,
      defaultForwardingMode: params.defaultForwardingMode,
    });
    if (!approvalModeIncludesSession(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    if (
      !doesApprovalRequestMatchChannelAccount({
        cfg: input.cfg,
        request: input.request,
        channel: params.channel,
        accountId: input.accountId,
      })
    ) {
      return false;
    }
    return hasChannelOriginOrSessionTarget(input);
  };

  const isExplicitTargetEligible = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
    target: NativeApprovalForwardTarget;
  }): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingModeWithDefault({
      config,
      defaultForwardingMode: params.defaultForwardingMode,
    });
    if (!approvalModeIncludesTargets(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    return hasMatchingChannelTarget({
      cfg: input.cfg,
      config,
      accountId: input.accountId,
      target: input.target,
    });
  };

  const shouldHandleApprovalRequest = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }): boolean =>
    isSessionApprovalEligible({
      ...input,
      approvalKind: resolveApprovalKind(input.request, input.approvalKind),
    });

  return {
    canApprovalPotentiallyRouteToChannel,
    canAnyApprovalPotentiallyRouteToChannel,
    isNativeApprovalHandlerConfigured: (input) =>
      canAnyApprovalPotentiallyRouteToChannel({
        ...input,
        nativeSessionOnly: true,
      }),
    isSessionApprovalEligible,
    isExplicitTargetEligible,
    shouldHandleApprovalRequest,
  };
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
