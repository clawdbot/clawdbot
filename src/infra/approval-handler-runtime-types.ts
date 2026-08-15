// Defines channel-native approval handler runtime types.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime-types.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type {
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

export type { ChannelApprovalKind } from "./approval-types.js";

/** Union of approval request events a native approval handler can receive. */
export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
/** Union of approval resolution events a native approval handler can finalize. */
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

/** Shared context passed to channel-native approval hooks. */
export type ChannelApprovalCapabilityHandlerContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
};

/** Result instruction for updating, deleting, clearing, or leaving a delivered approval entry. */
export type ChannelApprovalNativeFinalAction<TPayload> =
  | { kind: "update"; payload: TPayload }
  | { kind: "delete" }
  | { kind: "clear-actions" }
  | { kind: "leave" };

/** Availability gate for deciding whether a channel-native approval runtime can handle work. */
export type ChannelApprovalNativeAvailabilityAdapter = {
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean;
  shouldHandle: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      /** Payload-derived owner; channel adapters must not infer ownership from the id. */
      approvalKind: ChannelApprovalKind;
    },
  ) => boolean;
};

/** Builds channel-native payloads for pending, resolved, and expired approval views. */
export type ChannelApprovalNativePresentationAdapter<
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = {
  buildPendingPayload: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      nowMs: number;
      view: PendingApprovalView;
    },
  ) => TPendingPayload | Promise<TPendingPayload>;
  buildResolvedResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      resolved: ApprovalResolved;
      view: ResolvedApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  buildExpiredResult: (
    params: ChannelApprovalCapabilityHandlerContext & {
      request: ApprovalRequest;
      view: ExpiredApprovalView;
      entry: unknown;
    },
  ) =>
    | ChannelApprovalNativeFinalAction<TFinalPayload>
    | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
};

type ChannelApprovalNativeTransportAdapterForView<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  prepareTarget: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverPending: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: TPreparedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => TPendingEntry | null | Promise<TPendingEntry | null>;
  updateEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      payload: TFinalPayload;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
  deleteEntry?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
};

/** Transport hooks for preparing, delivering, updating, and deleting native approval entries. */
export type ChannelApprovalNativeTransportAdapter<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = ChannelApprovalNativeTransportAdapterForView<
  TPreparedTarget,
  TPendingEntry,
  TPendingPayload,
  TFinalPayload
>;

type ChannelApprovalNativeInteractionAdapterForView<
  TPendingEntry = unknown,
  TBinding = unknown,
  TPendingPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  bindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => TBinding | null | Promise<TBinding | null>;
  unbindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      binding: TBinding;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
    },
  ) => Promise<void> | void;
  clearPendingActions?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      phase: "resolved" | "expired";
    },
  ) => Promise<void>;
  cancelDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
    },
  ) => Promise<void> | void;
};

/** Optional hooks for binding and clearing interactive approval controls. */
export type ChannelApprovalNativeInteractionAdapter<
  TPendingEntry = unknown,
  TBinding = unknown,
> = ChannelApprovalNativeInteractionAdapterForView<TPendingEntry, TBinding>;

type ChannelApprovalNativeObserveAdapterForView<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
> = {
  onDeliveryError?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      error: unknown;
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDuplicateSkipped?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: TPendingView;
      pendingPayload: TPendingPayload;
      entry: TPendingEntry;
    },
  ) => void;
};

/** Optional observer hooks for delivery errors, duplicates, and successful deliveries. */
export type ChannelApprovalNativeObserveAdapter<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
> = ChannelApprovalNativeObserveAdapterForView<TPreparedTarget, TPendingPayload, TPendingEntry>;

/** Runtime adapter consumed by core after a plugin's strongly typed spec has been erased. */
export type ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> = {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  /**
   * Trusted legacy ownership override retained for compatibility.
   * @deprecated Omit this so core derives approval ownership from the request payload.
   */
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
  presentation: ChannelApprovalNativePresentationAdapter<TPendingPayload, TFinalPayload>;
  transport: ChannelApprovalNativeTransportAdapter<
    TPreparedTarget,
    TPendingEntry,
    TPendingPayload,
    TFinalPayload
  >;
  interactions?: ChannelApprovalNativeInteractionAdapter<TPendingEntry, TBinding>;
  observe?: ChannelApprovalNativeObserveAdapter;
};

/** Strongly typed plugin spec used to build a channel-native approval runtime adapter. */
export type ChannelApprovalNativeRuntimeSpec<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
> = {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  /**
   * Trusted legacy ownership override retained for compatibility.
   * @deprecated Omit this so core derives approval ownership from the request payload.
   */
  resolveApprovalKind?: (request: ApprovalRequest) => ChannelApprovalKind;
  availability: ChannelApprovalNativeAvailabilityAdapter;
  presentation: {
    buildPendingPayload: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        approvalKind: ChannelApprovalKind;
        nowMs: number;
        view: TPendingView;
      },
    ) => TPendingPayload | Promise<TPendingPayload>;
    buildResolvedResult: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        resolved: ApprovalResolved;
        view: TResolvedView;
        entry: TPendingEntry;
      },
    ) =>
      | ChannelApprovalNativeFinalAction<TFinalPayload>
      | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
    buildExpiredResult: (
      params: ChannelApprovalCapabilityHandlerContext & {
        request: ApprovalRequest;
        view: TExpiredView;
        entry: TPendingEntry;
      },
    ) =>
      | ChannelApprovalNativeFinalAction<TFinalPayload>
      | Promise<ChannelApprovalNativeFinalAction<TFinalPayload>>;
  };
  transport: ChannelApprovalNativeTransportAdapterForView<
    TPreparedTarget,
    TPendingEntry,
    TPendingPayload,
    TFinalPayload,
    TPendingView
  >;
  interactions?: ChannelApprovalNativeInteractionAdapterForView<
    TPendingEntry,
    TBinding,
    TPendingPayload,
    TPendingView
  >;
  observe?: ChannelApprovalNativeObserveAdapterForView<
    TPreparedTarget,
    TPendingPayload,
    TPendingEntry,
    TPendingView
  >;
};
