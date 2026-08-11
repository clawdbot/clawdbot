import {
  isFastModeAutoProgressPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import { type AgentPlanStep, formatPlanChecklistLines } from "../../channels/streaming.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ChooseDispatchRouteReadyState } from "./dispatch-from-config.choose-route.js";
import { hasAskUserPayload, hasExecApprovalPayload } from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import { loadGetReplyFromConfigRuntime } from "./dispatch-from-config.runtime-loaders.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

export async function prepareDispatchExecution(state: ChooseDispatchRouteReadyState) {
  const {
    cfg,
    ctx,
    dispatcher,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    noteCommentaryProgress,
    params,
    sendPayloadAsync,
    sessionKey,
    shouldEmitVerboseProgress,
    shouldRouteToOriginating,
    shouldSendToolSummaries,
    shouldSendVerboseProgressMessages,
    turnLedger,
  } = state;
  // When automatic source delivery is suppressed, still let the agent process
  // the inbound message (context, memory, tool calls) but suppress automatic
  // outbound source delivery.
  if (state.suppressDelivery) {
    logVerbose(
      `Delivery suppressed by ${state.deliverySuppressionReason} for session ${state.sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`,
    );
  }

  let didSendPlanStatusNotice = false;
  const formatPlanUpdateText = (payload: { explanation?: string; steps?: AgentPlanStep[] }) => {
    const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
    const steps = (payload.steps ?? [])
      .map((entry) => ({ step: entry.step.replace(/\s+/g, " ").trim(), status: entry.status }))
      .filter((entry) => entry.step);
    if (steps.length > 0) {
      return formatPlanChecklistLines(steps, {
        maxLines: steps.length,
        maxLineChars: 120,
      }).join("\n");
    }
    return explanation || "Planning next steps.";
  };
  const sendPlanUpdate = async (payload: {
    explanation?: string;
    steps?: AgentPlanStep[];
  }): Promise<void> => {
    if (
      shouldSuppressProgressDelivery() ||
      !shouldSendVerboseProgressMessages() ||
      didSendPlanStatusNotice
    ) {
      return;
    }
    didSendPlanStatusNotice = true;
    const replyPayload: ReplyPayload = {
      text: formatPlanUpdateText(payload),
      isStatusNotice: true,
    };
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(replyPayload, undefined, false);
      return;
    }
    markInboundDedupeReplayUnsafe();
    turnLedger.sendQueued("tool", replyPayload);
  };
  // Track accumulated block text for TTS generation after streaming completes.
  // When block streaming succeeds, there's no final reply, so we need to generate
  // TTS audio separately from the accumulated block content.
  const progressState = {
    accumulatedBlockText: "",
    accumulatedBlockTtsText: "",
    acceptedReplyPayload: false,
    blockCount: 0,
    channelTransformSuppressed: false,
    hasPendingDirectBlockReplyDelivery: false,
    progressCallbackStartTail: Promise.resolve(),
  };
  const cleanBlockTtsDirectiveText = shouldCleanTtsDirectiveText({
    cfg,
    ttsAuto: state.sessionTtsAuto,
    agentId: state.sessionAgentId,
    channelId: state.deliveryChannel,
    accountId: state.replyRoute.accountId,
  })
    ? createTtsDirectiveTextStreamCleaner()
    : undefined;

  const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      shouldSuppressLocalExecApprovalPrompt({
        channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
        cfg,
        accountId: ctx.AccountId,
        payload,
      })
    ) {
      return null;
    }
    if (shouldSendToolSummaries()) {
      return payload;
    }
    if (hasExecApprovalPayload(payload)) {
      return payload;
    }
    if (hasAskUserPayload(payload)) {
      return payload;
    }
    if (isFastModeAutoProgressPayload(payload)) {
      return payload;
    }
    // Group/native flows intentionally suppress tool summary text, but media-only
    // tool results (for example TTS audio) must still be delivered.
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (!hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  };
  const typing = resolveRunTypingPolicy({
    requestedPolicy: params.replyOptions?.typingPolicy,
    suppressTyping: state.sourceReplyPolicy.suppressTyping,
    originatingChannel: state.routeReplyChannel,
    systemEvent: shouldRouteToOriginating,
  });
  const shouldSuppressProgressDelivery = () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery && !state.shouldDeliverVerboseProgressDespiteSourceSuppression());
  const hasVisibleRegularVerboseToolProgress = () =>
    shouldEmitVerboseProgress() &&
    !state.shouldEmitFullVerboseProgress() &&
    shouldSendVerboseProgressMessages() &&
    ctx.InboundEventKind !== "room_event" &&
    !shouldSuppressProgressDelivery();
  let observedVisibleToolErrorProgress = false;
  const markVisibleToolErrorProgress = () => {
    if (hasVisibleRegularVerboseToolProgress()) {
      observedVisibleToolErrorProgress = true;
    }
  };
  const hasFailedProgressStatus = (payload: {
    phase?: string;
    status?: string;
    exitCode?: number | null;
  }) =>
    payload.phase === "error" ||
    payload.status === "failed" ||
    payload.status === "error" ||
    (typeof payload.exitCode === "number" && payload.exitCode !== 0);
  const shouldSuppressToolErrorWarnings = () => {
    if (params.replyOptions?.suppressToolErrorWarnings !== undefined) {
      return params.replyOptions.suppressToolErrorWarnings;
    }
    if (!shouldEmitVerboseProgress()) {
      return false;
    }
    return observedVisibleToolErrorProgress ? true : undefined;
  };
  const suppressToolErrorWarnings =
    params.replyOptions?.suppressToolErrorWarnings ??
    (observedVisibleToolErrorProgress ? true : undefined);
  const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
  const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
  const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
  const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
  const allowSuppressedSourceProgressCallbacks =
    params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
  const shouldAllowQuietChannelOwnedProgressCallbacks = (options?: {
    allowWhenToolSummariesHidden?: boolean;
    requiresToolSummaryVisibility?: boolean;
  }) =>
    options?.requiresToolSummaryVisibility === true &&
    (params.replyOptions?.suppressDefaultToolProgressMessages === true ||
      options.allowWhenToolSummariesHidden === true);
  const waitForPendingDirectBlockReplyDelivery = async (abortSignal?: AbortSignal) => {
    if (!progressState.hasPendingDirectBlockReplyDelivery) {
      return;
    }
    // Direct block replies are queued asynchronously so lightweight replies do
    // not wait for dispatcher idle. Flush only before later tool/progress
    // callbacks and final completion where external ordering is visible.
    progressState.hasPendingDirectBlockReplyDelivery = false;
    await waitForReplyDispatcherIdle(dispatcher, abortSignal);
  };
  const shouldForwardProgressCallback = (options?: {
    allowWhenToolSummariesHidden?: boolean;
    forwardWhenSourceDeliverySuppressed?: boolean;
    requiresToolSummaryVisibility?: boolean;
  }) => {
    if (
      options?.requiresToolSummaryVisibility === true &&
      !shouldSendToolSummaries() &&
      !shouldAllowQuietChannelOwnedProgressCallbacks(options)
    ) {
      return false;
    }
    return (
      !state.suppressAutomaticSourceDelivery ||
      (allowSuppressedSourceProgressCallbacks &&
        !state.sendPolicyDenied &&
        options?.forwardWhenSourceDeliverySuppressed === true)
    );
  };
  const preserveProgressCallbackStartOrder =
    params.replyOptions?.preserveProgressCallbackStartOrder === true;
  const reserveProgressCallbackStart = () => {
    const previousStart = progressState.progressCallbackStartTail;
    let releaseStart: (() => void) | undefined;
    progressState.progressCallbackStartTail = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    return {
      previousStart,
      releaseStart: () => releaseStart?.(),
    };
  };
  const wrapProgressCallback = <Args extends unknown[], Result extends boolean | void>(
    callback: ((...args: Args) => Promise<Result> | Result) | undefined,
    options?: {
      allowWhenToolSummariesHidden?: boolean;
      forwardWhenSourceDeliverySuppressed?: boolean;
      requiresToolSummaryVisibility?: boolean;
      onForward?: (...args: Args) => Promise<void> | void;
      onVisible?: (...args: Args) => Promise<void> | void;
      waitForDirectBlockReplyDelivery?: boolean;
    },
  ): ((...args: Args) => Promise<Result | undefined>) | undefined => {
    if (!callback) {
      return undefined;
    }
    const runProgressCallback = async (
      args: Args,
      noteCallbackStarted: () => void,
    ): Promise<Result | undefined> => {
      try {
        if (isDispatchOperationAborted()) {
          return undefined;
        }
        state.getDispatchReplyOperation()?.recordActivity();
        markProgress();
        if (options?.waitForDirectBlockReplyDelivery) {
          await waitForPendingDirectBlockReplyDelivery(
            state.getDispatchAbortOperation()?.abortSignal,
          );
          if (isDispatchOperationAborted()) {
            return undefined;
          }
        }
        if (shouldForwardProgressCallback(options)) {
          if (preserveProgressCallbackStartOrder && options?.onForward) {
            await options.onForward(...args);
          } else if (!preserveProgressCallbackStartOrder) {
            // Preserve the historical microtask boundary for unflagged channels.
            await options?.onForward?.(...args);
          }
          const callbackResult = callback(...args);
          noteCallbackStarted();
          const result = await callbackResult;
          if (result === false) {
            return result;
          }
          await options?.onVisible?.(...args);
        }
        return undefined;
      } finally {
        noteCallbackStarted();
      }
    };
    return (...args: Args) => {
      if (!preserveProgressCallbackStartOrder) {
        return runProgressCallback(args, () => undefined);
      }
      // Reserve source order synchronously. Release after callback invocation, not completion,
      // so async presentation work stays concurrent without letting later activity overtake it.
      const start = reserveProgressCallbackStart();
      return (async () => {
        await start.previousStart;
        return await runProgressCallback(args, start.releaseStart);
      })();
    };
  };

  // Snapshot verbose progress visibility for this run: commentary
  // classification in the CLI runners is wired once at run start, so a
  // mid-run verbose toggle cannot move inter-tool commentary between lanes.
  const deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress();
  const itemEventForwardingOptions = {
    forwardWhenSourceDeliverySuppressed: true,
    requiresToolSummaryVisibility: true,
  } as const;
  const canForwardItemEvents = Boolean(params.replyOptions?.onItemEvent);
  const canForwardSuppressedSourceItemEvents =
    allowSuppressedSourceProgressCallbacks &&
    !state.sendPolicyDenied &&
    Boolean(params.replyOptions?.onItemEvent);
  const shouldDeliverDurableCommentaryProgress = (
    payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0],
  ) =>
    deliverStandaloneCommentaryProgress &&
    payload.kind === "preamble" &&
    payload.suppressDurableProgress !== true;
  const forwardItemEvent = canForwardItemEvents
    ? wrapProgressCallback(params.replyOptions?.onItemEvent, {
        ...itemEventForwardingOptions,
        waitForDirectBlockReplyDelivery: true,
        onForward: (payload) =>
          preserveProgressCallbackStartOrder && shouldDeliverDurableCommentaryProgress(payload)
            ? noteCommentaryProgress(payload)
            : undefined,
        onVisible: (payload) => {
          if (hasFailedProgressStatus(payload)) {
            markVisibleToolErrorProgress();
          }
        },
      })
    : undefined;
  const canCaptureCliPreambleEvents =
    Boolean(params.replyOptions?.onItemEvent) && shouldBridgeCliPreambleEvents(params.replyOptions);
  const canConsumeItemEvents =
    deliverStandaloneCommentaryProgress || canForwardItemEvents || canCaptureCliPreambleEvents;
  // CLI runners classify preambles as item events only when this handler exists.
  // Keep it for channel-owned capture even when delivery policy hides the event.
  const onItemEvent = canConsumeItemEvents
    ? async (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) => {
        if (isDispatchOperationAborted()) {
          return;
        }
        if (!forwardItemEvent && deliverStandaloneCommentaryProgress) {
          // The wrapped forwarder marks progress itself when present.
          markProgress();
        }
        if (
          (!forwardItemEvent || !preserveProgressCallbackStartOrder) &&
          shouldDeliverDurableCommentaryProgress(payload)
        ) {
          await noteCommentaryProgress(payload);
        }
        return await forwardItemEvent?.(payload);
      }
    : undefined;
  // Let draft-rendering channels yield their ephemeral commentary lines while
  // the durable verbose commentary lane is delivering the same content.
  params.replyOptions?.onVerboseProgressVisibility?.(
    () =>
      deliverStandaloneCommentaryProgress &&
      shouldSendVerboseProgressMessages() &&
      !shouldSuppressProgressDelivery(),
  );

  const replyResolver =
    params.replyResolver ??
    (
      await state.traceReplyPhase("reply.load_reply_resolver", () =>
        loadGetReplyFromConfigRuntime(),
      )
    ).getReplyFromConfig;
  const runtimeReplyConfig = state.preparedReplyDispatchRuntime?.config ?? cfg;
  const replyConfig = withFullRuntimeReplyConfig(
    params.configOverride
      ? (applyMergePatch(runtimeReplyConfig, params.configOverride) as OpenClawConfig)
      : runtimeReplyConfig,
  );
  state.recordAgentDispatchStarted();
  const nextState = extendPreparedDispatchState(state, {
    sendPlanUpdate,
    cleanBlockTtsDirectiveText,
    resolveToolDeliveryPayload,
    typing,
    shouldSuppressProgressDelivery,
    markVisibleToolErrorProgress,
    hasFailedProgressStatus,
    shouldSuppressToolErrorWarnings,
    suppressToolErrorWarnings,
    onToolResultFromReplyOptions,
    onPlanUpdateFromReplyOptions,
    onApprovalEventFromReplyOptions,
    onPatchSummaryFromReplyOptions,
    waitForPendingDirectBlockReplyDelivery,
    shouldForwardProgressCallback,
    preserveProgressCallbackStartOrder,
    wrapProgressCallback,
    deliverStandaloneCommentaryProgress,
    canForwardSuppressedSourceItemEvents,
    onItemEvent,
    replyResolver,
    replyConfig,
    progressState,
  });
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchExecutionResult = Awaited<ReturnType<typeof prepareDispatchExecution>>;
export type PrepareDispatchExecutionReadyState = Extract<
  PrepareDispatchExecutionResult,
  { status: "ready" }
>["state"];
