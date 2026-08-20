import type { ChannelApprovalKind } from "../infra/approval-types.js";
// Approval delivery helpers format approval prompts and results for channel plugins.
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalMessagingTargetResolvers,
  type NativeApprovalTarget,
} from "./approval-native-helpers.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";
import { normalizeMessageChannel } from "./routing.js";
import { normalizeOptionalString } from "./string-coerce-runtime.js";

type NativeApprovalDeliveryMode = "dm" | "channel" | "both";
type NativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type NativeApprovalSurface = "origin" | "approver-dm";
type ChannelApprovalCapabilitySurfaces = Pick<
  ChannelApprovalCapability,
  "delivery" | "nativeRuntime" | "render" | "native"
>;

type ApprovalAdapterParams = {
  /** Full config used to inspect channel approval settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped approval settings. */
  accountId?: string | null;
  /** Actor attempting the approval action. */
  senderId?: string | null;
};

type DeliverySuppressionParams = {
  /** Full config used to inspect native approval delivery settings. */
  cfg: OpenClawConfig;
  /** Approval kind being delivered. */
  approvalKind: ChannelApprovalKind;
  /** Forwarding fallback target under consideration. */
  target: { channel: string; accountId?: string | null };
  /** Approval request metadata, including original turn source when available. */
  request: { request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
};

type ApproverRestrictedNativeApprovalCommonParams = {
  /** Channel id that owns this native approval capability. */
  channel: string;
  /** Human-readable channel label used in denial messages. */
  channelLabel: string;
  /** Optional setup description helper shown when exec approvals are unavailable. */
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
  /** Optional setup description helper shown when plugin approvals are unavailable. */
  describePluginApprovalSetup?: ChannelApprovalCapability["describePluginApprovalSetup"];
  /** Native runtime hooks used by channel-specific delivery implementations. */
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
};

type ApproverRestrictedNativeApprovalFlatParams = {
  /** Lists configured account ids so DM-route availability can scan every account. */
  listAccountIds: (cfg: OpenClawConfig) => string[];
  /** Whether an account has approvers configured. */
  hasApprovers: (params: ApprovalAdapterParams) => boolean;
  /** Whether a sender can approve exec approvals for this account. */
  isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean;
  /** Optional plugin approval authorization hook; defaults to exec authorization. */
  isPluginAuthorizedSender?: (params: ApprovalAdapterParams) => boolean;
  /** Whether native approval delivery is enabled for an account. */
  isNativeDeliveryEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Native delivery target preference for an account. */
  resolveNativeDeliveryMode: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => NativeApprovalDeliveryMode;
  /** Requires the approval request's original turn channel to match this channel before suppression. */
  requireMatchingTurnSourceChannel?: boolean;
  /** Optional account id resolver used when deciding forwarding-fallback suppression. */
  resolveSuppressionAccountId?: (params: DeliverySuppressionParams) => string | undefined;
  /** Resolves the original channel target for native approval delivery. */
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget | null | Promise<NativeApprovalTarget | null>;
  /** Resolves approver DM targets for native approval delivery. */
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget[] | Promise<NativeApprovalTarget[]>;
  /** Whether DM-only native delivery should also notify the origin channel. */
  notifyOriginWhenDmOnly?: boolean;
};

type StandardNativeApprovalRouting = Pick<
  ReturnType<typeof createNativeApprovalChannelRouteGates>,
  | "canApprovalPotentiallyRouteToChannel"
  | "canAnyApprovalPotentiallyRouteToChannel"
  | "isNativeApprovalHandlerConfigured"
  | "shouldHandleApprovalRequest"
> & {
  getActionAvailabilityState: NonNullable<ChannelApprovalCapability["getActionAvailabilityState"]>;
  getExecInitiatingSurfaceState: NonNullable<
    ChannelApprovalCapability["getExecInitiatingSurfaceState"]
  >;
  delivery: NonNullable<ChannelApprovalCapability["delivery"]>;
  native: NonNullable<ChannelApprovalCapability["native"]>;
};

type ApproverRestrictedNativeApprovalRoutedParams = {
  /** Standard forwarding-backed native routing assembled inside the capability factory. */
  routing: StandardNativeApprovalRoutingParams;
  /** Channel-owned authorization, including any implicit same-chat fallback marker. */
  authorizeActorAction: NonNullable<ChannelApprovalCapability["authorizeActorAction"]>;
  /** Builds native runtime hooks after the shared routing policy exists. */
  createNativeRuntime?: (
    routing: StandardNativeApprovalRouting,
  ) => ChannelApprovalCapability["nativeRuntime"];
  /** Render hooks for pending and resolved approval payloads. */
  render?: ChannelApprovalCapability["render"];
};

type StandardNativeApprovalRoutingParams = {
  /** Default forwarding mode when top-level approval config omits one. */
  defaultForwardingMode: "session" | "targets" | "both";
  /** Whether the channel transport is available for an account. */
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Lists channel account ids for route and DM availability checks. */
  listAccountIds: (cfg: OpenClawConfig) => readonly string[];
  /** Resolves the channel's default account id. */
  resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
  /** Normalizes a channel-local messaging destination. */
  normalizeTo: (to: string) => string | null | undefined;
  /** Resolves configured native approval recipients. */
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly string[];
  /** Optional origin safety gate, such as requiring approvers for group conversations. */
  isOriginTargetAllowed?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ChannelApprovalKind;
    request: NativeApprovalRequest;
    target: NativeApprovalTarget;
  }) => boolean;
  /** Whether explicit target forwarding participates in exact-match fallback suppression. */
  suppressExplicitTargetFallback?: boolean;
  /** Whether DM-only native delivery should also notify the origin channel. */
  notifyOriginWhenDmOnly?: boolean;
};

function createStandardNativeApprovalRouting(
  channel: string,
  params: StandardNativeApprovalRoutingParams,
): StandardNativeApprovalRouting {
  const targetResolvers = createNativeApprovalMessagingTargetResolvers({
    channel,
    normalizeTo: params.normalizeTo,
  });
  const routeGates = createNativeApprovalChannelRouteGates({
    channel,
    defaultForwardingMode: params.defaultForwardingMode,
    isTransportEnabled: params.isTransportEnabled,
    listAccountIds: params.listAccountIds,
    resolveDefaultAccountId: params.resolveDefaultAccountId,
    normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
  });
  const resolveOriginTargetBase = createChannelNativeOriginTargetResolver({
    channel,
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
    resolveSessionTarget: targetResolvers.resolveSessionTarget,
    normalizeTarget: targetResolvers.normalizeTarget,
  });
  const resolveOriginTarget = (input: Parameters<typeof resolveOriginTargetBase>[0]) => {
    const target = resolveOriginTargetBase(input);
    if (
      !target ||
      (params.isOriginTargetAllowed && !params.isOriginTargetAllowed({ ...input, target }))
    ) {
      return null;
    }
    return target;
  };
  const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveApprovers: params.resolveApprovers,
    mapApprover: (approver, input) => {
      const to = params.normalizeTo(approver);
      return to ? { to, accountId: normalizeOptionalString(input.accountId) } : null;
    },
  });
  const shouldSuppressForwardingFallback =
    createNativeApprovalForwardingFallbackSuppressor<NativeApprovalTarget>({
      channel,
      normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
      resolveAccountId: ({ forwardingTarget, request }) =>
        forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
      resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
        ...forwardingTarget,
        accountId,
      }),
      isSessionRouteEligible: routeGates.isSessionApprovalEligible,
      isExplicitTargetEligible:
        params.suppressExplicitTargetFallback === false
          ? undefined
          : routeGates.isExplicitTargetEligible,
      resolveOriginTarget,
      resolveApproverDmTargets,
    });
  const availabilityState = (enabled: boolean) =>
    enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);

  return {
    canApprovalPotentiallyRouteToChannel: routeGates.canApprovalPotentiallyRouteToChannel,
    canAnyApprovalPotentiallyRouteToChannel: routeGates.canAnyApprovalPotentiallyRouteToChannel,
    isNativeApprovalHandlerConfigured: routeGates.isNativeApprovalHandlerConfigured,
    shouldHandleApprovalRequest: routeGates.shouldHandleApprovalRequest,
    getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
      availabilityState(
        approvalKind
          ? routeGates.canApprovalPotentiallyRouteToChannel({ cfg, accountId, approvalKind })
          : routeGates.canAnyApprovalPotentiallyRouteToChannel({ cfg, accountId }),
      ),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      availabilityState(
        routeGates.canApprovalPotentiallyRouteToChannel({
          cfg,
          accountId,
          approvalKind: "exec",
        }),
      ),
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        params.listAccountIds(cfg).some(
          (accountId) =>
            routeGates.canAnyApprovalPotentiallyRouteToChannel({
              cfg,
              accountId,
              nativeSessionOnly: true,
            }) && params.resolveApprovers({ cfg, accountId }).length > 0,
        ),
      shouldSuppressForwardingFallback,
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId, approvalKind, request }) => {
        const input = { cfg, accountId, approvalKind, request };
        const originTarget = resolveOriginTarget(input);
        const approverTargets = resolveApproverDmTargets(input);
        return {
          enabled: Boolean(originTarget) || approverTargets.length > 0,
          preferredSurface: originTarget ? "origin" : "approver-dm",
          supportsOriginSurface: Boolean(originTarget),
          supportsApproverDmSurface: approverTargets.length > 0,
          notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? true,
        };
      },
      resolveOriginTarget,
      resolveApproverDmTargets,
    },
  };
}

/** Build the canonical approval capability for channels that restrict approvals to configured approvers. */
function buildApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalCommonParams & ApproverRestrictedNativeApprovalFlatParams,
): ChannelApprovalCapability {
  const pluginSenderAuth = params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender;
  const availabilityState = (enabled: boolean) =>
    enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
  const normalizePreferredSurface = (
    mode: NativeApprovalDeliveryMode,
  ): NativeApprovalSurface | "both" =>
    mode === "channel" ? "origin" : mode === "dm" ? "approver-dm" : "both";
  const hasConfiguredApprovers = ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => params.hasApprovers({ cfg, accountId });
  const isExecInitiatingSurfaceEnabled = ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) =>
    hasConfiguredApprovers({ cfg, accountId }) &&
    params.isNativeDeliveryEnabled({ cfg, accountId });
  const resolveExecInitiatingSurfaceState = ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
  }) => availabilityState(isExecInitiatingSurfaceEnabled({ cfg, accountId }));

  return createChannelApprovalCapability({
    authorizeActorAction: ({
      cfg,
      accountId,
      senderId,
      approvalKind,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      senderId?: string | null;
      action: "approve";
      approvalKind: ChannelApprovalKind;
    }) => {
      const authorized =
        approvalKind === "plugin"
          ? pluginSenderAuth({ cfg, accountId, senderId })
          : params.isExecAuthorizedSender({ cfg, accountId, senderId });
      return authorized
        ? { authorized: true }
        : {
            authorized: false,
            reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
          };
    },
    getActionAvailabilityState: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      action: "approve";
      approvalKind?: ChannelApprovalKind;
    }) => availabilityState(hasConfiguredApprovers({ cfg, accountId })),
    getExecInitiatingSurfaceState: resolveExecInitiatingSurfaceState,
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    describePluginApprovalSetup: params.describePluginApprovalSetup,
    delivery: {
      hasConfiguredDmRoute: ({ cfg }: { cfg: OpenClawConfig }) =>
        params.listAccountIds(cfg).some((accountId) => {
          if (!hasConfiguredApprovers({ cfg, accountId })) {
            return false;
          }
          if (!params.isNativeDeliveryEnabled({ cfg, accountId })) {
            return false;
          }
          const target = params.resolveNativeDeliveryMode({ cfg, accountId });
          return target === "dm" || target === "both";
        }),
      shouldSuppressForwardingFallback: (input: DeliverySuppressionParams) => {
        const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
        if (channel !== params.channel) {
          return false;
        }
        if (params.requireMatchingTurnSourceChannel) {
          const turnSourceChannel = normalizeMessageChannel(
            input.request.request.turnSourceChannel,
          );
          if (turnSourceChannel !== params.channel) {
            return false;
          }
        }
        const resolvedAccountId = params.resolveSuppressionAccountId?.(input);
        const accountId =
          (resolvedAccountId === undefined
            ? input.target.accountId?.trim()
            : resolvedAccountId.trim()) || undefined;
        // Suppress generic forwarding only when this channel's native route can
        // handle the same account; otherwise the fallback is the only delivery path.
        return params.isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
      },
    },
    native:
      params.resolveOriginTarget || params.resolveApproverDmTargets
        ? {
            describeDeliveryCapabilities: ({
              cfg,
              accountId,
            }: {
              cfg: OpenClawConfig;
              accountId?: string | null;
              approvalKind: ChannelApprovalKind;
              request: NativeApprovalRequest;
            }) => ({
              enabled: isExecInitiatingSurfaceEnabled({ cfg, accountId }),
              preferredSurface: normalizePreferredSurface(
                params.resolveNativeDeliveryMode({ cfg, accountId }),
              ),
              supportsOriginSurface: Boolean(params.resolveOriginTarget),
              supportsApproverDmSurface: Boolean(params.resolveApproverDmTargets),
              notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? false,
            }),
            resolveOriginTarget: params.resolveOriginTarget,
            resolveApproverDmTargets: params.resolveApproverDmTargets,
          }
        : undefined,
    nativeRuntime: params.nativeRuntime,
  });
}

/** Build the split approval adapter shape for approver-restricted native channels. */
export function createApproverRestrictedNativeApprovalAdapter(
  params: ApproverRestrictedNativeApprovalCommonParams & ApproverRestrictedNativeApprovalFlatParams,
) {
  return splitChannelApprovalCapability(buildApproverRestrictedNativeApprovalCapability(params));
}

/** Assemble a channel approval capability from its auth, delivery, render, and native surfaces. */
export function createChannelApprovalCapability(params: {
  /** Authorizes actors attempting approval actions. */
  authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
  /** Reports whether approval actions are generally available. */
  getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
  /** Reports whether exec approvals can start from the initiating surface. */
  getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
  /** Optional command behavior override for approval replies. */
  resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
  /** Optional setup copy for unavailable exec approval paths. */
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
  /** Optional setup copy for unavailable plugin approval paths. */
  describePluginApprovalSetup?: ChannelApprovalCapability["describePluginApprovalSetup"];
  /** Delivery fallback and DM-route helpers. */
  delivery?: ChannelApprovalCapability["delivery"];
  /** Native runtime hooks for channel-specific approval delivery. */
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
  /** Render hooks for pending/resolved approval payloads. */
  render?: ChannelApprovalCapability["render"];
  /** Native target/capability discovery hooks. */
  native?: ChannelApprovalCapability["native"];
}): ChannelApprovalCapability {
  const surfaces: ChannelApprovalCapabilitySurfaces = {
    delivery: params.delivery,
    nativeRuntime: params.nativeRuntime,
    render: params.render,
    native: params.native,
  };
  return {
    authorizeActorAction: params.authorizeActorAction,
    getActionAvailabilityState: params.getActionAvailabilityState,
    getExecInitiatingSurfaceState: params.getExecInitiatingSurfaceState,
    resolveApproveCommandBehavior: params.resolveApproveCommandBehavior,
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    describePluginApprovalSetup: params.describePluginApprovalSetup,
    delivery: surfaces.delivery,
    nativeRuntime: surfaces.nativeRuntime,
    render: surfaces.render,
    native: surfaces.native,
  };
}

/** Split the canonical approval capability into the adapter shape older channel loaders consume. */
export function splitChannelApprovalCapability(capability: ChannelApprovalCapability): {
  auth: {
    authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
    getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
    getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
    resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
  };
  delivery: ChannelApprovalCapability["delivery"];
  nativeRuntime: ChannelApprovalCapability["nativeRuntime"];
  render: ChannelApprovalCapability["render"];
  native: ChannelApprovalCapability["native"];
  describeExecApprovalSetup: ChannelApprovalCapability["describeExecApprovalSetup"];
  describePluginApprovalSetup: ChannelApprovalCapability["describePluginApprovalSetup"];
} {
  return {
    auth: {
      authorizeActorAction: capability.authorizeActorAction,
      getActionAvailabilityState: capability.getActionAvailabilityState,
      getExecInitiatingSurfaceState: capability.getExecInitiatingSurfaceState,
      resolveApproveCommandBehavior: capability.resolveApproveCommandBehavior,
    },
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    render: capability.render,
    native: capability.native,
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    describePluginApprovalSetup: capability.describePluginApprovalSetup,
  };
}

/** Build the canonical approval capability for approver-restricted native delivery channels. */
export function createApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalCommonParams & ApproverRestrictedNativeApprovalFlatParams,
): ChannelApprovalCapability {
  return buildApproverRestrictedNativeApprovalCapability(params);
}

/** Build a forwarding-routed capability and expose its shared route gates to the owning channel. */
export function createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes(
  params: ApproverRestrictedNativeApprovalCommonParams &
    ApproverRestrictedNativeApprovalRoutedParams,
): { capability: ChannelApprovalCapability; routing: StandardNativeApprovalRouting } {
  const routing = createStandardNativeApprovalRouting(params.channel, params.routing);
  return {
    capability: createChannelApprovalCapability({
      authorizeActorAction: params.authorizeActorAction,
      getActionAvailabilityState: routing.getActionAvailabilityState,
      getExecInitiatingSurfaceState: routing.getExecInitiatingSurfaceState,
      describeExecApprovalSetup: params.describeExecApprovalSetup,
      describePluginApprovalSetup: params.describePluginApprovalSetup,
      delivery: routing.delivery,
      native: routing.native,
      nativeRuntime: params.createNativeRuntime?.(routing) ?? params.nativeRuntime,
      render: params.render,
    }),
    routing,
  };
}
