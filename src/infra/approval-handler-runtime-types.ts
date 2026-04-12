import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime.js";
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

export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export type ChannelApprovalCapabilityHandlerContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
};

export type ChannelApprovalNativeFinalAction<TPayload> =
  | { kind: "update"; payload: TPayload }
  | { kind: "delete" }
  | { kind: "clear-actions" }
  | { kind: "leave" };

export type ChannelApprovalNativeAvailabilityAdapter = {
  isConfigured: (params: ChannelApprovalCapabilityHandlerContext) => boolean;
  shouldHandle: (
    params: ChannelApprovalCapabilityHandlerContext & { request: ApprovalRequest },
  ) => boolean;
};

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

export type ChannelApprovalNativeTransportAdapter<
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TPendingPayload = unknown,
  TFinalPayload = unknown,
> = {
  prepareTarget: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
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
      view: PendingApprovalView;
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

export type ChannelApprovalNativeInteractionAdapter<TPendingEntry = unknown, TBinding = unknown> = {
  bindPending?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      entry: TPendingEntry;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: unknown;
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
};

export type ChannelApprovalNativeObserveAdapter<
  TPreparedTarget = unknown,
  TPendingPayload = unknown,
  TPendingEntry = unknown,
> = {
  onDeliveryError?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      error: unknown;
      plannedTarget: ChannelApprovalNativePlannedTarget;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDuplicateSkipped?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
    },
  ) => void;
  onDelivered?: (
    params: ChannelApprovalCapabilityHandlerContext & {
      plannedTarget: ChannelApprovalNativePlannedTarget;
      preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
      request: ApprovalRequest;
      approvalKind: ChannelApprovalKind;
      view: PendingApprovalView;
      pendingPayload: TPendingPayload;
      entry: TPendingEntry;
    },
  ) => void;
};

export type ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
> = {
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
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
  transport: {
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
  interactions?: {
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
  };
  observe?: {
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
};
