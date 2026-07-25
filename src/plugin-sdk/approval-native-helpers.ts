// Approval native helpers translate plugin approval requests into host-native approval records.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
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

type ApprovalTransportChecker = ChannelApprovalForwardingEvaluatorParams["isTransportEnabled"];
type ApprovalForwardingModeResolver = (
  config: ExecApprovalForwardingConfig,
) => ExecApprovalForwardingMode;
type ApprovalForwardingTargetMatcher =
  ChannelApprovalForwardingEvaluatorParams["hasMatchingTarget"];
type ApprovalOriginOrSessionTargetChecker =
  ChannelApprovalForwardingEvaluatorParams["hasOriginOrSessionTarget"];

/** Inputs for checking whether one approval request can use session-native forwarding. */
export type ChannelApprovalForwardingEligibilityParams = {
  /** Full config containing exec/plugin approval forwarding settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped transport checks. */
  accountId?: string | null;
  /** Approval family whose forwarding config should be evaluated. */
  approvalKind: ApprovalKind;
  /** Approval request being considered for native delivery. */
  request: ApprovalRequest;
};

/** Inputs for checking whether approval forwarding is configured for a channel route. */
export type ChannelApprovalPotentialRouteParams = {
  /** Full config containing exec/plugin approval forwarding settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped transport checks. */
  accountId?: string | null;
  /** Approval family whose forwarding config should be evaluated. */
  approvalKind: ApprovalKind;
  /** When true, ignore explicit target routes and only consider session/native origin routes. */
  nativeSessionOnly?: boolean;
};

/** Inputs for checking whether one configured target can receive an approval request. */
export type ChannelApprovalExplicitTargetEligibilityParams =
  ChannelApprovalForwardingEligibilityParams & {
    /** Forwarding target that may be handled by the channel-native approval route. */
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

type BaseOriginResolverParams<TTarget> = {
  /** Channel id whose origin target should be resolved. */
  channel: string;
  /** Optional gate; returning false prevents native origin delivery. */
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  /** Maps request turn-source metadata to a native target. */
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  /** Maps a persisted session target to a native target. */
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  /** Normalizes the returned target before delivery. */
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  /** Normalizes only matcher inputs when delivery target shape must stay native. */
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  /** Optional fallback target when neither turn-source nor session target resolves. */
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

type NativeOriginResolverParams<TTarget extends NativeApprovalTarget> =
  BaseOriginResolverParams<TTarget> & {
    /** Optional native target matcher; defaults to route-exact target matching. */
    targetsMatch?: (a: TTarget, b: TTarget) => boolean;
  };

type CustomOriginResolverParams<TTarget> = BaseOriginResolverParams<TTarget> & {
  /** Custom matcher required when target shape is not `NativeApprovalTarget`. */
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
};

/** Standard channel-native approval destination used by route and origin matchers. */
export type NativeApprovalTarget = {
  /** Channel-local destination id. */
  to: string;
  /** Optional channel account id associated with the destination. */
  accountId?: string | null;
  /** Optional thread/topic id inside the destination. */
  threadId?: string | number | null;
};

/** Compare channel-native approval targets with the same normalization used by outbound routes. */
export function nativeApprovalTargetsMatch(params: {
  /** Channel id used for route target normalization. */
  channel?: string | null;
  /** Left native target to compare. */
  left: NativeApprovalTarget;
  /** Right native target to compare. */
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

/** Decide whether a channel-native exec approval route replaces the local text prompt. */
export function shouldSuppressLocalNativeExecApprovalPrompt(params: {
  /** Full config containing top-level or channel-specific approval settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped native delivery checks. */
  accountId?: string | null;
  /** Reply payload that may already contain exec approval metadata. */
  payload: ReplyPayload;
  /** Outbound payload hint proving an active native exec approval route. */
  hint?: ChannelOutboundPayloadHint;
  /** Legacy transport gate for native delivery. */
  isTransportEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Preferred transport gate for native delivery. */
  isNativeDeliveryEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Optional channel-specific approval config resolver. */
  resolveApprovalConfig?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => LocalNativeExecApprovalConfig | undefined;
  /** Whether the resolved approval config must be enabled before suppressing local prompt. */
  requireApprovalConfigEnabled?: boolean;
  /** Whether forwarding mode must be session/both unless exact target proof is present. */
  enforceForwardingMode?: boolean;
  /** Optional session-route gate for the approval metadata. */
  isSessionRouteEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => boolean;
  /** Proof that target-mode forwarding already matched this exact native target. */
  hasExactTargetProof?: boolean;
  /** Whether agent filters may fall back to the agent segment in sessionKey. */
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
    // In targets-only mode, local prompt suppression requires exact target
    // proof so a session/native route cannot hide the only visible prompt.
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

/** Infer approval family from the request shape unless the caller already knows it. */
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

function resolveActiveApprovalForwarding(
  params: ChannelApprovalPotentialRouteParams & {
    isTransportEnabled: ApprovalTransportChecker;
    resolveMode: ApprovalForwardingModeResolver;
  },
): { config: ExecApprovalForwardingConfig; mode: ExecApprovalForwardingMode } | null {
  if (!params.isTransportEnabled(params)) {
    return null;
  }
  const config = resolveApprovalForwardingConfig(params);
  if (!config?.enabled) {
    return null;
  }
  return {
    config,
    mode: params.resolveMode(config),
  };
}

function canApprovalPotentiallyRoute(
  params: ChannelApprovalPotentialRouteParams & {
    isTransportEnabled: ApprovalTransportChecker;
    resolveMode: ApprovalForwardingModeResolver;
    hasMatchingTarget: ApprovalForwardingTargetMatcher;
  },
): boolean {
  const forwarding = resolveActiveApprovalForwarding(params);
  if (!forwarding) {
    return false;
  }
  if (approvalModeIncludesSession(forwarding.mode)) {
    return true;
  }
  if (params.nativeSessionOnly) {
    return false;
  }
  return (
    approvalModeIncludesTargets(forwarding.mode) &&
    params.hasMatchingTarget({
      cfg: params.cfg,
      config: forwarding.config,
      accountId: params.accountId,
    })
  );
}

function isSessionApprovalEligibleViaForwarding(
  params: ChannelApprovalForwardingEligibilityParams & {
    channel: string;
    isTransportEnabled: ApprovalTransportChecker;
    resolveMode: ApprovalForwardingModeResolver;
    hasOriginOrSessionTarget: ApprovalOriginOrSessionTargetChecker;
  },
): boolean {
  const forwarding = resolveActiveApprovalForwarding(params);
  if (!forwarding) {
    return false;
  }
  if (!approvalModeIncludesSession(forwarding.mode)) {
    return false;
  }
  if (!matchesForwardingFilters({ config: forwarding.config, request: params.request })) {
    return false;
  }
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: params.channel,
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  return params.hasOriginOrSessionTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request,
  });
}

function isExplicitTargetApprovalEligibleViaForwarding(
  params: ChannelApprovalExplicitTargetEligibilityParams & {
    isTransportEnabled: ApprovalTransportChecker;
    resolveMode: ApprovalForwardingModeResolver;
    hasMatchingTarget: ApprovalForwardingTargetMatcher;
  },
): boolean {
  const forwarding = resolveActiveApprovalForwarding(params);
  if (!forwarding) {
    return false;
  }
  if (!approvalModeIncludesTargets(forwarding.mode)) {
    return false;
  }
  if (!matchesForwardingFilters({ config: forwarding.config, request: params.request })) {
    return false;
  }
  return params.hasMatchingTarget({
    cfg: params.cfg,
    config: forwarding.config,
    accountId: params.accountId,
    target: params.target,
  });
}

/** Build reusable forwarding gates for channels with custom target matching logic. */
export function createChannelApprovalForwardingEvaluator(
  params: ChannelApprovalForwardingEvaluatorParams,
) {
  const resolveForwardingMode = (config: ExecApprovalForwardingConfig) =>
    normalizeApprovalForwardingMode(config.mode);

  const isPotentialRoute = (input: ChannelApprovalPotentialRouteParams): boolean => {
    return canApprovalPotentiallyRoute({
      ...input,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasMatchingTarget: params.hasMatchingTarget,
    });
  };

  const isSessionEligible = (input: ChannelApprovalForwardingEligibilityParams): boolean => {
    return isSessionApprovalEligibleViaForwarding({
      ...input,
      channel: params.channel,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasOriginOrSessionTarget: params.hasOriginOrSessionTarget,
    });
  };

  const isExplicitTargetEligible = (
    input: ChannelApprovalExplicitTargetEligibilityParams,
  ): boolean => {
    return isExplicitTargetApprovalEligibleViaForwarding({
      ...input,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasMatchingTarget: params.hasMatchingTarget,
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

/** Create the standard route gates for native channel approval forwarding. */
export function createNativeApprovalChannelRouteGates<TTarget extends NativeApprovalTarget>(
  params: NativeApprovalChannelRouteGateParams<TTarget>,
): NativeApprovalChannelRouteGates {
  const resolveForwardingMode = (config: ExecApprovalForwardingConfig) =>
    normalizeApprovalForwardingModeWithDefault({
      config,
      defaultForwardingMode: params.defaultForwardingMode,
    });

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
    // Unscoped targets are safe for a non-default account only when exactly
    // one enabled account can receive them; otherwise they would be ambiguous.
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
    return canApprovalPotentiallyRoute({
      ...input,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasMatchingTarget: hasMatchingChannelTarget,
    });
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
    return isSessionApprovalEligibleViaForwarding({
      ...input,
      channel: params.channel,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasOriginOrSessionTarget: hasChannelOriginOrSessionTarget,
    });
  };

  const isExplicitTargetEligible = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
    target: NativeApprovalForwardTarget;
  }): boolean => {
    return isExplicitTargetApprovalEligibleViaForwarding({
      ...input,
      isTransportEnabled: params.isTransportEnabled,
      resolveMode: resolveForwardingMode,
      hasMatchingTarget: hasMatchingChannelTarget,
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

/** Create a fallback suppressor that avoids duplicate approval prompts after native delivery. */
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
        // Some transports need native delivery ids unchanged while matching on
        // normalized aliases, so matcher normalization is separate from output normalization.
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

/** Resolve a request origin target using standard native approval target matching. */
export function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(
  params: NativeOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
/** Resolve a request origin target for channels with custom target shapes. */
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

/** Create a resolver for configured approver DM targets. */
export function createChannelApproverDmTargetResolver<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  /** Optional gate; returning false skips approver DM delivery for the request. */
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  /** Resolves approver records from config and optional account scope. */
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  /** Maps one approver record to a native DM target; nullish results are skipped. */
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
