// Compat surface: openclaw/plugin-sdk/approval-handler-runtime
// Provides stable types and factory helpers for channel exec/plugin approval handlers.

import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";

// ---------------------------------------------------------------------------
// Shared approval metadata
// ---------------------------------------------------------------------------

export type ApprovalMetadataEntry = { label: string; value: string };

// ---------------------------------------------------------------------------
// Exec approval views
// ---------------------------------------------------------------------------

export type ExecApprovalPendingView = {
  approvalKind: "exec";
  approvalId: string;
  commandText: string;
  commandPreview?: string | null;
  expiresAtMs: number;
  metadata: ApprovalMetadataEntry[];
  actions: ExecApprovalActionDescriptorStub[];
};

export type ExecApprovalResolvedView = {
  approvalKind: "exec";
  approvalId: string;
  commandText: string;
  commandPreview?: string | null;
  decision: ExecApprovalDecision;
};

export type ExecApprovalExpiredView = {
  approvalKind: "exec";
  approvalId: string;
  commandText: string;
  commandPreview?: string | null;
};

// ---------------------------------------------------------------------------
// Plugin approval views
// ---------------------------------------------------------------------------

export type PluginApprovalPendingView = {
  approvalKind: "plugin";
  approvalId: string;
  title: string;
  description?: string | null;
  severity: "info" | "warn" | "critical";
  expiresAtMs: number;
  metadata: ApprovalMetadataEntry[];
  actions: ExecApprovalActionDescriptorStub[];
};

export type PluginApprovalResolvedView = {
  approvalKind: "plugin";
  approvalId: string;
  title: string;
  decision: ExecApprovalDecision;
};

export type PluginApprovalExpiredView = {
  approvalKind: "plugin";
  approvalId: string;
  title: string;
};

// ---------------------------------------------------------------------------
// Union views
// ---------------------------------------------------------------------------

export type PendingApprovalView = ExecApprovalPendingView | PluginApprovalPendingView;
export type ResolvedApprovalView = ExecApprovalResolvedView | PluginApprovalResolvedView;
export type ExpiredApprovalView = ExecApprovalExpiredView | PluginApprovalExpiredView;

// ---------------------------------------------------------------------------
// Internal action descriptor stub
// ---------------------------------------------------------------------------

/** Minimal shape of an approval action descriptor as used by handlers. */
type ExecApprovalActionDescriptorStub = {
  id: string;
  label: string;
  decision: ExecApprovalDecision;
};

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export type ChannelApprovalCapabilityHandlerContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: unknown;
  request?: unknown;
};

// ---------------------------------------------------------------------------
// Adapter interface and factory
// ---------------------------------------------------------------------------

/** Opaque adapter returned by createChannelApprovalNativeRuntimeAdapter. */
export type ChannelApprovalNativeRuntimeAdapter = {
  readonly __channelApprovalNativeRuntimeAdapter: true;
};

type ApprovalEventKind = "exec" | "plugin";

type AdapterAvailabilityParams = ChannelApprovalCapabilityHandlerContext;

type AdapterPresentationParams<TDelivery> = {
  cfg: OpenClawConfig;
  accountId: string;
  context?: unknown;
  view: PendingApprovalView;
  approvalKind: ApprovalEventKind;
  nowMs: number;
  request?: unknown;
  plannedTarget?: unknown;
};

type AdapterTransportParams<TDelivery, TTarget, TPending> = {
  cfg: OpenClawConfig;
  accountId: string;
  context?: unknown;
  preparedTarget: TTarget;
  pendingPayload: TDelivery;
  plannedTarget?: { target: unknown; dedupeKey?: string };
};

type AdapterConfig<TDelivery, TTarget, TPending, TResolved> = {
  eventKinds: ApprovalEventKind[];
  resolveApprovalKind?: (request: unknown) => ApprovalEventKind;
  availability: {
    isConfigured: (params: AdapterAvailabilityParams) => boolean;
    shouldHandle: (params: AdapterAvailabilityParams) => boolean;
  };
  presentation: {
    buildPendingPayload: (
      params: AdapterPresentationParams<TDelivery>,
    ) => TDelivery;
    buildResolvedResult: (
      params: Omit<AdapterPresentationParams<TDelivery>, "view"> & {
        view: ResolvedApprovalView;
      },
    ) => unknown;
    buildExpiredResult: (
      params: Omit<AdapterPresentationParams<TDelivery>, "view"> & {
        view: ExpiredApprovalView;
      },
    ) => unknown;
  };
  transport: {
    prepareTarget?: (params: {
      plannedTarget: { target: unknown; dedupeKey?: string };
    }) => { target: TTarget; dedupeKey?: string };
    deliverPending?: (
      params: AdapterTransportParams<TDelivery, TTarget, TPending>,
    ) => Promise<TPending | null>;
    updatePending?: (
      params: AdapterTransportParams<TDelivery, TTarget, TPending> & {
        pendingDelivery: TPending;
      },
    ) => Promise<void>;
    deletePending?: (
      params: { cfg: OpenClawConfig; accountId: string; pendingDelivery: TPending },
    ) => Promise<void>;
  };
};

/**
 * Factory for channel-native approval runtime adapters.
 * Returns an opaque adapter object that is registered with the approval system.
 */
export function createChannelApprovalNativeRuntimeAdapter<
  TDelivery,
  TTarget,
  TPending,
  TResolved,
>(
  _config: AdapterConfig<TDelivery, TTarget, TPending, TResolved>,
): ChannelApprovalNativeRuntimeAdapter {
  return _config as unknown as ChannelApprovalNativeRuntimeAdapter;
}
