import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type {
  ChannelApprovalNativeAvailabilityAdapter,
  ChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime-types.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";

export const CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native";

export function createLazyChannelApprovalNativeRuntimeAdapter<
  TPendingPayload = unknown,
  TPreparedTarget = unknown,
  TPendingEntry = unknown,
  TBinding = unknown,
  TFinalPayload = unknown,
>(params: {
  load: () => Promise<
    ChannelApprovalNativeRuntimeAdapter<
      TPendingPayload,
      TPreparedTarget,
      TPendingEntry,
      TBinding,
      TFinalPayload
    >
  >;
  isConfigured: ChannelApprovalNativeAvailabilityAdapter["isConfigured"];
  shouldHandle: ChannelApprovalNativeAvailabilityAdapter["shouldHandle"];
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
}): ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding,
  TFinalPayload
> {
  const loadRuntime = createLazyRuntimeModule(params.load);
  let loadedRuntime: ChannelApprovalNativeRuntimeAdapter<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload
  > | null = null;
  const loadResolvedRuntime = async (): Promise<
    ChannelApprovalNativeRuntimeAdapter<
      TPendingPayload,
      TPreparedTarget,
      TPendingEntry,
      TBinding,
      TFinalPayload
    >
  > => {
    const runtime = await loadRuntime();
    loadedRuntime = runtime;
    return runtime;
  };
  const loadRequired = async <TResult>(
    select: (
      runtime: ChannelApprovalNativeRuntimeAdapter<
        TPendingPayload,
        TPreparedTarget,
        TPendingEntry,
        TBinding,
        TFinalPayload
      >,
    ) => TResult,
  ): Promise<TResult> => select(await loadResolvedRuntime());
  const loadOptional = async <TResult>(
    select: (
      runtime: ChannelApprovalNativeRuntimeAdapter<
        TPendingPayload,
        TPreparedTarget,
        TPendingEntry,
        TBinding,
        TFinalPayload
      >,
    ) => TResult | undefined,
  ): Promise<TResult | undefined> => select(await loadResolvedRuntime());

  return {
    ...(params.eventKinds ? { eventKinds: params.eventKinds } : {}),
    ...(params.resolveApprovalKind ? { resolveApprovalKind: params.resolveApprovalKind } : {}),
    availability: {
      isConfigured: params.isConfigured,
      shouldHandle: params.shouldHandle,
    },
    presentation: {
      buildPendingPayload: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildPendingPayload))(runtimeParams),
      buildResolvedResult: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildResolvedResult))(runtimeParams),
      buildExpiredResult: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.presentation.buildExpiredResult))(runtimeParams),
    },
    transport: {
      prepareTarget: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.transport.prepareTarget))(runtimeParams),
      deliverPending: async (runtimeParams) =>
        (await loadRequired((runtime) => runtime.transport.deliverPending))(runtimeParams),
      updateEntry: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.transport.updateEntry)
        )?.(runtimeParams),
      deleteEntry: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.transport.deleteEntry)
        )?.(runtimeParams),
    },
    interactions: {
      bindPending: async (runtimeParams) =>
        (await loadOptional((runtime) => runtime.interactions?.bindPending))?.(runtimeParams) ??
        null,
      unbindPending: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.interactions?.unbindPending)
        )?.(runtimeParams),
      clearPendingActions: async (runtimeParams) =>
        await (
          await loadOptional((runtime) => runtime.interactions?.clearPendingActions)
        )?.(runtimeParams),
    },
    observe: {
      // Observe hooks are fire-and-forget at call sites. Reuse the already
      // loaded runtime instead of introducing unawaited lazy-load promises.
      onDeliveryError: (runtimeParams) => loadedRuntime?.observe?.onDeliveryError?.(runtimeParams),
      onDuplicateSkipped: (runtimeParams) =>
        loadedRuntime?.observe?.onDuplicateSkipped?.(runtimeParams),
      onDelivered: (runtimeParams) => loadedRuntime?.observe?.onDelivered?.(runtimeParams),
    },
  };
}
