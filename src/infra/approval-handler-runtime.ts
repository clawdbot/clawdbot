import type {
  ChannelApprovalCapability,
  ChannelApprovalNativeAdapter,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-adapter-runtime.js";
import type {
  ApprovalRequest,
  ApprovalResolved,
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalKind,
  ChannelApprovalNativeFinalAction,
  ChannelApprovalNativeRuntimeAdapter,
  ChannelApprovalNativeRuntimeSpec,
} from "./approval-handler-runtime-types.js";
import type {
  ChannelNativeApprovalDeliveryCallbacks,
  ChannelNativeApprovalTransportSpec,
} from "./approval-native-runtime-types.js";
import { createChannelNativeApprovalRuntime } from "./approval-native-runtime.js";
import {
  buildExpiredApprovalView,
  buildPendingApprovalView,
  buildResolvedApprovalView,
} from "./approval-view-model.js";
import type {
  ApprovalActionView,
  ApprovalMetadataView,
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import type { ExecApprovalChannelRuntime } from "./exec-approval-channel-runtime.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";

export type {
  ApprovalActionView,
  ApprovalMetadataView,
  ApprovalViewModel,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
export {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
};
export type {
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalNativeAvailabilityAdapter,
  ChannelApprovalNativeFinalAction,
  ChannelApprovalNativeInteractionAdapter,
  ChannelApprovalNativeObserveAdapter,
  ChannelApprovalNativePresentationAdapter,
  ChannelApprovalNativeRuntimeAdapter,
  ChannelApprovalNativeRuntimeSpec,
  ChannelApprovalNativeTransportAdapter,
} from "./approval-handler-runtime-types.js";

export type ChannelApprovalHandler<
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = ExecApprovalChannelRuntime<TRequest, TResolved>;

type WrappedPendingEntry = {
  entry: unknown;
  binding?: unknown;
};

type ActiveApprovalEntries = {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  entries: WrappedPendingEntry[];
};

type WrappedPendingContent = {
  view: PendingApprovalView;
  payload: unknown;
};

function consumeActiveWrappedEntries(
  activeEntries: Map<string, ActiveApprovalEntries>,
  requestId: string,
  fallbackEntries: WrappedPendingEntry[],
): WrappedPendingEntry[] {
  const entries = activeEntries.get(requestId)?.entries ?? fallbackEntries;
  activeEntries.delete(requestId);
  return entries;
}

async function finalizeWrappedEntries(params: {
  entries: WrappedPendingEntry[];
  phase: "resolved" | "expired";
  request: ApprovalRequest;
  log: ReturnType<typeof createSubsystemLogger>;
  runEntry: (wrapped: WrappedPendingEntry) => Promise<void>;
}): Promise<void> {
  for (const wrapped of params.entries) {
    try {
      await params.runEntry(wrapped);
    } catch (error) {
      params.log.error(
        `failed to finalize ${params.phase} native approval entry ` +
          `approval=${params.request.id}: ${String(error)}`,
      );
    }
  }
}

async function unbindWrappedEntries(params: {
  entries: WrappedPendingEntry[];
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  baseContext: ChannelApprovalCapabilityHandlerContext;
  nativeRuntime: ChannelApprovalNativeRuntimeAdapter;
  log: ReturnType<typeof createSubsystemLogger>;
}): Promise<void> {
  if (!params.nativeRuntime.interactions?.unbindPending) {
    return;
  }
  for (const wrapped of params.entries) {
    if (wrapped.binding === undefined) {
      continue;
    }
    try {
      await params.nativeRuntime.interactions.unbindPending({
        ...params.baseContext,
        entry: wrapped.entry,
        binding: wrapped.binding,
        request: params.request,
        approvalKind: params.approvalKind,
      });
    } catch (error) {
      params.log.error(
        `failed to unbind stopped native approval entry ` +
          `approval=${params.request.id}: ${String(error)}`,
      );
    }
  }
}

async function applyApprovalFinalAction(params: {
  nativeRuntime: ChannelApprovalNativeRuntimeAdapter;
  baseContext: ChannelApprovalCapabilityHandlerContext;
  wrapped: WrappedPendingEntry;
  result: ChannelApprovalNativeFinalAction<unknown>;
  phase: "resolved" | "expired";
}): Promise<void> {
  switch (params.result.kind) {
    case "update":
      await params.nativeRuntime.transport.updateEntry?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        payload: params.result.payload,
        phase: params.phase,
      });
      return;
    case "delete":
      await params.nativeRuntime.transport.deleteEntry?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        phase: params.phase,
      });
      return;
    case "clear-actions":
      await params.nativeRuntime.interactions?.clearPendingActions?.({
        ...params.baseContext,
        entry: params.wrapped.entry,
        phase: params.phase,
      });
      return;
    case "leave":
      return;
  }
}

export function createChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
>(
  spec: ChannelApprovalNativeRuntimeSpec<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload,
    TPendingView,
    TResolvedView,
    TExpiredView
  >,
): ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding,
  TFinalPayload
> {
  return {
    ...(spec.eventKinds ? { eventKinds: spec.eventKinds } : {}),
    ...(spec.resolveApprovalKind ? { resolveApprovalKind: spec.resolveApprovalKind } : {}),
    availability: {
      isConfigured: spec.availability.isConfigured,
      shouldHandle: spec.availability.shouldHandle,
    },
    presentation: {
      buildPendingPayload: async (params) =>
        await spec.presentation.buildPendingPayload(params as never),
      buildResolvedResult: async (params) =>
        await spec.presentation.buildResolvedResult(params as never),
      buildExpiredResult: async (params) =>
        await spec.presentation.buildExpiredResult(params as never),
    },
    transport: {
      prepareTarget: async (params) => await spec.transport.prepareTarget(params as never),
      deliverPending: async (params) => await spec.transport.deliverPending(params as never),
      ...(spec.transport.updateEntry
        ? {
            updateEntry: async (
              params: {
                entry: unknown;
                payload: unknown;
                phase: "resolved" | "expired";
              } & ChannelApprovalCapabilityHandlerContext,
            ) => await spec.transport.updateEntry?.(params as never),
          }
        : {}),
      ...(spec.transport.deleteEntry
        ? {
            deleteEntry: async (
              params: {
                entry: unknown;
                phase: "resolved" | "expired";
              } & ChannelApprovalCapabilityHandlerContext,
            ) => await spec.transport.deleteEntry?.(params as never),
          }
        : {}),
    },
    ...(spec.interactions
      ? {
          interactions: {
            ...(spec.interactions.bindPending
              ? {
                  bindPending: async (params) =>
                    (await spec.interactions!.bindPending!(params as never)) ?? null,
                }
              : {}),
            ...(spec.interactions.unbindPending
              ? {
                  unbindPending: async (params) =>
                    await spec.interactions?.unbindPending?.(params as never),
                }
              : {}),
            ...(spec.interactions.clearPendingActions
              ? {
                  clearPendingActions: async (params) =>
                    await spec.interactions?.clearPendingActions?.(params as never),
                }
              : {}),
          },
        }
      : {}),
    ...(spec.observe
      ? {
          observe: {
            ...(spec.observe.onDeliveryError
              ? {
                  onDeliveryError: (params) => spec.observe?.onDeliveryError?.(params as never),
                }
              : {}),
            ...(spec.observe.onDuplicateSkipped
              ? {
                  onDuplicateSkipped: (params) =>
                    spec.observe?.onDuplicateSkipped?.(params as never),
                }
              : {}),
            ...(spec.observe.onDelivered
              ? {
                  onDelivered: (params) => spec.observe?.onDelivered?.(params as never),
                }
              : {}),
          },
        }
      : {}),
  };
}

type ChannelApprovalHandlerRuntimeSpec<TRequest extends ApprovalRequest> = {
  label: string;
  clientDisplayName: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  nativeAdapter?: ChannelApprovalNativeAdapter | null;
  resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
  isConfigured: () => boolean;
  shouldHandle: (request: TRequest) => boolean;
  nowMs?: () => number;
};

type ChannelApprovalHandlerContentSpec<
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
> = {
  buildPendingContent: (params: {
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    nowMs: number;
  }) => TPendingContent | Promise<TPendingContent>;
};

type ChannelApprovalHandlerTransportSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
> = ChannelNativeApprovalTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest>;

type ChannelApprovalHandlerLifecycleSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = ChannelNativeApprovalDeliveryCallbacks<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest
> & {
  finalizeResolved: (params: {
    request: TRequest;
    resolved: TResolved;
    entries: TPendingEntry[];
  }) => Promise<void>;
  finalizeExpired?: (params: { request: TRequest; entries: TPendingEntry[] }) => Promise<void>;
  onStopped?: () => Promise<void> | void;
};

export type ChannelApprovalHandlerAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = {
  runtime: ChannelApprovalHandlerRuntimeSpec<TRequest>;
  content: ChannelApprovalHandlerContentSpec<TPendingContent, TRequest>;
  transport: ChannelApprovalHandlerTransportSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest
  >;
  lifecycle: ChannelApprovalHandlerLifecycleSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >;
};

export function createChannelApprovalHandler<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelApprovalHandlerAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ChannelApprovalHandler<TRequest, TResolved> {
  return createChannelNativeApprovalRuntime<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >({
    label: adapter.runtime.label,
    clientDisplayName: adapter.runtime.clientDisplayName,
    cfg: adapter.runtime.cfg,
    gatewayUrl: adapter.runtime.gatewayUrl,
    eventKinds: adapter.runtime.eventKinds,
    channel: adapter.runtime.channel,
    channelLabel: adapter.runtime.channelLabel,
    accountId: adapter.runtime.accountId,
    nativeAdapter: adapter.runtime.nativeAdapter,
    resolveApprovalKind: adapter.runtime.resolveApprovalKind,
    isConfigured: adapter.runtime.isConfigured,
    shouldHandle: adapter.runtime.shouldHandle,
    nowMs: adapter.runtime.nowMs,
    buildPendingContent: adapter.content.buildPendingContent,
    prepareTarget: adapter.transport.prepareTarget,
    deliverTarget: adapter.transport.deliverTarget,
    onDeliveryError: adapter.lifecycle.onDeliveryError,
    onDuplicateSkipped: adapter.lifecycle.onDuplicateSkipped,
    onDelivered: adapter.lifecycle.onDelivered,
    finalizeResolved: adapter.lifecycle.finalizeResolved,
    finalizeExpired: adapter.lifecycle.finalizeExpired,
    onStopped: adapter.lifecycle.onStopped,
  });
}

export async function createChannelApprovalHandlerFromCapability(params: {
  capability?: Pick<ChannelApprovalCapability, "native" | "nativeRuntime"> | null;
  label: string;
  clientDisplayName: string;
  channel: string;
  channelLabel: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
  nowMs?: () => number;
}): Promise<ChannelApprovalHandler | null> {
  const nativeRuntime = params.capability?.nativeRuntime;
  if (!nativeRuntime) {
    return null;
  }
  const log = createSubsystemLogger(params.label);
  const activeEntries = new Map<string, ActiveApprovalEntries>();
  const resolveApprovalKind =
    nativeRuntime.resolveApprovalKind ??
    ((request: ApprovalRequest) =>
      request.id.startsWith("plugin:") ? "plugin" : ("exec" as const));
  const baseContext: ChannelApprovalCapabilityHandlerContext = {
    cfg: params.cfg,
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    context: params.context,
  };
  return createChannelApprovalHandler<WrappedPendingEntry, unknown, WrappedPendingContent>({
    runtime: {
      label: params.label,
      clientDisplayName: params.clientDisplayName,
      channel: params.channel,
      channelLabel: params.channelLabel,
      cfg: params.cfg,
      accountId: params.accountId,
      gatewayUrl: params.gatewayUrl,
      eventKinds: nativeRuntime.eventKinds,
      nativeAdapter: params.capability?.native as ChannelApprovalNativeAdapter | null,
      resolveApprovalKind,
      isConfigured: () => nativeRuntime.availability.isConfigured(baseContext),
      shouldHandle: (request) =>
        nativeRuntime.availability.shouldHandle({ ...baseContext, request }),
      nowMs: params.nowMs,
    },
    content: {
      buildPendingContent: async ({ request, approvalKind, nowMs }) => {
        const view = buildPendingApprovalView(request);
        return {
          view,
          payload: await nativeRuntime.presentation.buildPendingPayload({
            ...baseContext,
            request,
            approvalKind,
            nowMs,
            view,
          }),
        };
      },
    },
    transport: {
      prepareTarget: async ({ plannedTarget, request, approvalKind, pendingContent }) => {
        return await nativeRuntime.transport.prepareTarget({
          ...baseContext,
          plannedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        });
      },
      deliverTarget: async ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
      }) => {
        const entry = await nativeRuntime.transport.deliverPending({
          ...baseContext,
          plannedTarget,
          preparedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        });
        if (!entry) {
          return null;
        }
        const binding = await nativeRuntime.interactions?.bindPending?.({
          ...baseContext,
          entry,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        });
        const wrapped: WrappedPendingEntry = {
          entry,
          ...(binding === undefined || binding === null ? {} : { binding }),
        };
        const activeRequest = activeEntries.get(request.id) ?? {
          request,
          approvalKind,
          entries: [],
        };
        activeRequest.entries.push(wrapped);
        activeEntries.set(request.id, activeRequest);
        return wrapped;
      },
    },
    lifecycle: {
      onDeliveryError: ({ error, plannedTarget, request, approvalKind, pendingContent }) => {
        nativeRuntime.observe?.onDeliveryError?.({
          ...baseContext,
          error,
          plannedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        });
      },
      onDuplicateSkipped: ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
      }) => {
        nativeRuntime.observe?.onDuplicateSkipped?.({
          ...baseContext,
          plannedTarget,
          preparedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
        });
      },
      onDelivered: ({
        plannedTarget,
        preparedTarget,
        request,
        approvalKind,
        pendingContent,
        entry,
      }) => {
        nativeRuntime.observe?.onDelivered?.({
          ...baseContext,
          plannedTarget,
          preparedTarget,
          request,
          approvalKind,
          view: pendingContent.view,
          pendingPayload: pendingContent.payload,
          entry: entry.entry,
        });
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        const resolvedEntries = consumeActiveWrappedEntries(activeEntries, request.id, entries);
        const view = buildResolvedApprovalView(request, resolved);
        await finalizeWrappedEntries({
          entries: resolvedEntries,
          phase: "resolved",
          request,
          log,
          runEntry: async (wrapped) => {
            if (wrapped.binding !== undefined) {
              await nativeRuntime.interactions?.unbindPending?.({
                ...baseContext,
                entry: wrapped.entry,
                binding: wrapped.binding,
                request,
                approvalKind: resolveApprovalKind(request),
              });
            }
            const result = await nativeRuntime.presentation.buildResolvedResult({
              ...baseContext,
              request,
              resolved,
              view,
              entry: wrapped.entry,
            });
            await applyApprovalFinalAction({
              nativeRuntime,
              baseContext,
              wrapped,
              result,
              phase: "resolved",
            });
          },
        });
      },
      finalizeExpired: async ({ request, entries }) => {
        const expiredEntries = consumeActiveWrappedEntries(activeEntries, request.id, entries);
        const view = buildExpiredApprovalView(request);
        await finalizeWrappedEntries({
          entries: expiredEntries,
          phase: "expired",
          request,
          log,
          runEntry: async (wrapped) => {
            if (wrapped.binding !== undefined) {
              await nativeRuntime.interactions?.unbindPending?.({
                ...baseContext,
                entry: wrapped.entry,
                binding: wrapped.binding,
                request,
                approvalKind: resolveApprovalKind(request),
              });
            }
            const result = await nativeRuntime.presentation.buildExpiredResult({
              ...baseContext,
              request,
              view,
              entry: wrapped.entry,
            });
            await applyApprovalFinalAction({
              nativeRuntime,
              baseContext,
              wrapped,
              result,
              phase: "expired",
            });
          },
        });
      },
      onStopped: async () => {
        if (activeEntries.size === 0) {
          activeEntries.clear();
          return;
        }
        for (const activeRequest of activeEntries.values()) {
          await unbindWrappedEntries({
            entries: activeRequest.entries,
            request: activeRequest.request,
            approvalKind: activeRequest.approvalKind,
            baseContext,
            nativeRuntime,
            log,
          });
        }
        activeEntries.clear();
      },
    },
  });
}
