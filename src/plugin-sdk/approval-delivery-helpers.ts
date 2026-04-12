import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";
import { normalizeMessageChannel } from "./routing.js";

type ApprovalKind = "exec" | "plugin";
type NativeApprovalDeliveryMode = "dm" | "channel" | "both";
type NativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type NativeApprovalTarget = { to: string; threadId?: string | number | null };
type NativeApprovalSurface = "origin" | "approver-dm";
type ChannelApprovalCapabilitySurfaces = Pick<
  ChannelApprovalCapability,
  "delivery" | "nativeRuntime" | "render" | "native"
>;

type ApprovalAdapterParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
};

type DeliverySuppressionParams = {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
  target: { channel: string; accountId?: string | null };
  request: { request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
};

type ApproverRestrictedNativeApprovalParams = {
  channel: string;
  channelLabel: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  hasApprovers: (params: ApprovalAdapterParams) => boolean;
  isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean;
  isPluginAuthorizedSender?: (params: ApprovalAdapterParams) => boolean;
  isNativeDeliveryEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  resolveNativeDeliveryMode: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => NativeApprovalDeliveryMode;
  requireMatchingTurnSourceChannel?: boolean;
  resolveSuppressionAccountId?: (params: DeliverySuppressionParams) => string | undefined;
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget | null | Promise<NativeApprovalTarget | null>;
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget[] | Promise<NativeApprovalTarget[]>;
  notifyOriginWhenDmOnly?: boolean;
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
};

function buildApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalParams,
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
      approvalKind: ApprovalKind;
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
    }) => availabilityState(hasConfiguredApprovers({ cfg, accountId })),
    getExecInitiatingSurfaceState: resolveExecInitiatingSurfaceState,
    describeExecApprovalSetup: params.describeExecApprovalSetup,
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
              approvalKind: ApprovalKind;
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

export function createApproverRestrictedNativeApprovalAdapter(
  params: ApproverRestrictedNativeApprovalParams,
) {
  return splitChannelApprovalCapability(buildApproverRestrictedNativeApprovalCapability(params));
}

export function createChannelApprovalCapability(params: {
  authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
  getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
  getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
  resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
  delivery?: ChannelApprovalCapability["delivery"];
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
  render?: ChannelApprovalCapability["render"];
  native?: ChannelApprovalCapability["native"];
  /** @deprecated Pass delivery/nativeRuntime/render/native directly. */
  approvals?: Partial<ChannelApprovalCapabilitySurfaces>;
}): ChannelApprovalCapability {
  const surfaces: ChannelApprovalCapabilitySurfaces = {
    delivery: params.delivery ?? params.approvals?.delivery,
    nativeRuntime: params.nativeRuntime ?? params.approvals?.nativeRuntime,
    render: params.render ?? params.approvals?.render,
    native: params.native ?? params.approvals?.native,
  };
  return {
    authorizeActorAction: params.authorizeActorAction,
    getActionAvailabilityState: params.getActionAvailabilityState,
    getExecInitiatingSurfaceState: params.getExecInitiatingSurfaceState,
    resolveApproveCommandBehavior: params.resolveApproveCommandBehavior,
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    delivery: surfaces.delivery,
    nativeRuntime: surfaces.nativeRuntime,
    render: surfaces.render,
    native: surfaces.native,
  };
}

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
  };
}

export function createApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalParams,
): ChannelApprovalCapability {
  return buildApproverRestrictedNativeApprovalCapability(params);
}
