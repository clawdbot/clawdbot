import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createPluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import {
  buildCaptionedFinalTextFallback,
  cleanDeferredFinalText,
  isCaptionedFinalTextPayload,
  mergeDeferredFinalText,
  shouldDeferFinalTtsText,
} from "../../tts/captioned-final.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { renderPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import {
  DispatchReplyOperationAbortedError,
  runWithDispatchAbortSignal,
} from "./dispatch-from-config.abort.js";
import {
  hasExecApprovalPayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import { suppressPendingFinalDelivery } from "./dispatch-from-config.pending-final.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { runReplyDispatchTakeover } from "./dispatch-from-config.reply-dispatch-hook.js";
import {
  maybeRefuseRestrictedRuntimeTakeover,
  runtimeTakeoverHooksAllowed,
} from "./dispatch-from-config.restricted-runtime.js";
import { createSessionMetadataChangeNotifier } from "./dispatch-from-config.session-metadata.js";
import {
  captureDeliveredTranscriptMirror,
  mirrorDeliveredReplyToTranscript,
  mirrorTranscriptAfterDispatcherSettled,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import type { NormalizeReplySkipReason } from "./normalize-reply.js";
import {
  resolveRoutedReplyDeliveryOutcome,
  shouldRetryReplyDispatch,
} from "./reply-dispatch-outcome.js";
import {
  attachReplyDispatchUndeliveredFallback,
  prepareReplyPayloadForDispatcher,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatcher.js";
import { isDispatchFinalReplySessionWriterAuthorized } from "./session-writer-delivery-authority.js";

export async function chooseDispatchRoute(state: PrepareDispatchOperationReadyState) {
  const {
    acpDispatchSessionKey,
    attachSourceReplyDeliveryMode,
    cfg,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliveryChannel,
    dispatcher,
    getPreDispatchAbortSignal,
    hookRunner,
    isRoutedReplyDelivered,
    markIdle,
    markInboundDedupeReplayUnsafe,
    params,
    recordProcessed,
    replyContextAccountId,
    replyRoute,
    resolvePreparedTranscriptBinding,
    routeReplyChannel,
    routeReplyThreadId,
    routeReplyTo,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    shouldEmitVerboseProgress,
    shouldRouteToOriginating,
    traceReplyPhase,
    trackDispatchLifecycleWork,
    turnLedger,
  } = state;
  const shouldSuppressProgressDelivery = () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression());
  const shouldSuppressDefaultToolProgressMessages = () =>
    params.replyOptions?.suppressToolProgressMessages === true || !shouldEmitVerboseProgress();
  const shouldSendVerboseProgressMessages = () => !shouldSuppressDefaultToolProgressMessages();
  const shouldSendToolSummaries = () => shouldSendVerboseProgressMessages();
  const { notifySessionMetadataChanges, routeState } = createSessionMetadataChangeNotifier(
    params.onSessionMetadataChanges,
  );
  const shouldDeliverVerboseProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied &&
    shouldEmitVerboseProgress() &&
    shouldSendVerboseProgressMessages();
  const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied &&
    params.replyOptions?.forceToolResultProgress === true;
  let finalReplyDeliveryStarted = false;
  const isSessionWriterDeliveryAuthorized = (payload: ReplyPayload) =>
    isDispatchFinalReplySessionWriterAuthorized(payload, sessionStoreEntry.storePath, sessionKey);
  const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) => {
    if (!finalReplyDeliveryStarted) {
      return false;
    }
    return !requiresDurableToolResultDelivery(payload);
  };
  // Durable inter-tool commentary lane: with verbose progress on, preamble
  // items become standalone progress messages like tool summaries. The latest
  // text per item id is buffered (snapshot producers re-emit the same item)
  // and flushed when the producer moves on, always before the final reply.
  let pendingCommentaryProgress: { itemId?: string; text: string } | null = null;
  const deliverCommentaryProgressMessage = async (text: string) => {
    if (!shouldSendToolSummaries() || shouldSuppressProgressDelivery()) {
      return;
    }
    const payload: ReplyPayload = { text: `💬 ${text}` };
    if (shouldSuppressLateTextOnlyToolProgress(payload)) {
      return;
    }
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(payload, undefined, false);
    } else {
      markInboundDedupeReplayUnsafe();
      turnLedger.sendQueued("tool", payload);
    }
  };
  const flushPendingCommentaryProgress = async () => {
    const pending = pendingCommentaryProgress;
    pendingCommentaryProgress = null;
    const text = pending?.text.trim();
    if (!text) {
      return;
    }
    await deliverCommentaryProgressMessage(text);
  };
  const noteCommentaryProgress = async (payload: { itemId?: string; progressText?: string }) => {
    const itemId = payload.itemId?.trim() || undefined;
    const text = payload.progressText ?? "";
    const repeatsBufferedText =
      pendingCommentaryProgress !== null && pendingCommentaryProgress.text.trim() === text.trim();
    const updatesBufferedItem =
      pendingCommentaryProgress !== null &&
      ((pendingCommentaryProgress.itemId !== undefined &&
        pendingCommentaryProgress.itemId === itemId) ||
        repeatsBufferedText);
    if (!text.trim()) {
      // Empty commentary with an item id means the producer retracted that
      // item; drop it if it has not been sent yet.
      if (updatesBufferedItem) {
        pendingCommentaryProgress = null;
      }
      return;
    }
    if (pendingCommentaryProgress && !updatesBufferedItem) {
      await flushPendingCommentaryProgress();
    }
    pendingCommentaryProgress = { itemId, text };
  };
  const shouldSuppressMessageToolOnlyTextErrorProgress = (payload: ReplyPayload) => {
    if (
      state.sourceReplyDeliveryMode !== "message_tool_only" ||
      state.shouldEmitFullVerboseProgress() ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
  const captionedFinalTtsContext = {
    cfg,
    ttsAuto: sessionTtsAuto,
    agentId: sessionAgentId,
    channelId: deliveryChannel,
    accountId: replyRoute.accountId,
    inboundAudio: state.inboundAudio,
  };
  const deferFinalTtsText = shouldDeferFinalTtsText(captionedFinalTtsContext);
  const cleanDeferredFinalDirectives = shouldCleanTtsDirectiveText(captionedFinalTtsContext);
  type BlockDelivery = { outcome: ReplyDispatchDeliveryOutcome; pending?: boolean };
  const blockDeliveryOutcomes = new Map<string, Array<Promise<BlockDelivery>>>();
  const recordBlockOutcome = (payload: ReplyPayload, outcome: Promise<BlockDelivery>) => {
    const key = createBlockReplyContentKey(payload);
    const outcomes = blockDeliveryOutcomes.get(key) ?? [];
    outcomes.push(outcome);
    blockDeliveryOutcomes.set(key, outcomes);
  };
  const sendTrackedBlockReply = (payload: ReplyPayload) => {
    const delivery = turnLedger.sendQueued("block", payload);
    if (delivery.queued) {
      recordBlockOutcome(
        payload,
        delivery.outcome?.then((outcome) => ({
          outcome,
          pending: delivery.hasPendingDelivery?.(),
        })) ?? Promise.resolve({ outcome: "failed-deliver" }),
      );
    }
    return delivery;
  };
  const recordRoutedBlockReplyDelivery = (
    payload: ReplyPayload,
    result: Awaited<ReturnType<typeof sendPayloadAsync>>,
  ): ReplyDispatchDeliveryOutcome | undefined => {
    if (!result) {
      return undefined;
    }
    const outcome = resolveRoutedReplyDeliveryOutcome(result);
    recordBlockOutcome(
      payload,
      Promise.resolve({
        outcome,
        pending: result.queueCustody === "held" || result.ambiguous === true,
      }),
    );
    return outcome;
  };
  const getBlockReplyOutcome = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
  ): Promise<BlockDelivery | undefined> => {
    const outcomes = blockDeliveryOutcomes.get(createBlockReplyContentKey(payload));
    if (!outcomes || abortSignal?.aborted) {
      return undefined;
    }
    const settled = await runWithDispatchAbortSignal(abortSignal, () => Promise.all(outcomes));
    return (
      settled.find(({ outcome }) => outcome === "delivered") ??
      settled.find(({ outcome, pending }) => pending || !shouldRetryReplyDispatch(outcome)) ??
      settled[0]
    );
  };
  const sendFinalPayload = async (
    inputPayload: ReplyPayload,
    options: {
      abortSignal?: AbortSignal | false;
      deliveryId?: string;
      deferredTtsText?: string;
      skipTts?: boolean;
    } = {},
  ): Promise<{
    blockDeliveryOutcome?: ReplyDispatchDeliveryOutcome;
    pendingBlock?: boolean;
    queuedFinal: boolean;
    routedFinalCount: number;
    suppressionReason?: NormalizeReplySkipReason;
    sessionWriterDeliveryRevoked?: true;
    dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
    routedOutcome?: ReplyDispatchDeliveryOutcome;
  }> => {
    const abortSignal =
      options.abortSignal === false
        ? undefined
        : (options.abortSignal ?? state.getDispatchAbortSignal());
    const throwIfFinalDeliveryAborted = () => {
      if (abortSignal?.aborted) {
        throw new DispatchReplyOperationAbortedError();
      }
    };
    throwIfFinalDeliveryAborted();
    // Trailing commentary must land ahead of the final answer.
    await flushPendingCommentaryProgress();
    throwIfFinalDeliveryAborted();
    const preparation = prepareReplyPayloadForDispatcher(dispatcher, "final", inputPayload);
    if (preparation.kind === "suppress") {
      await suppressPendingFinalDelivery(inputPayload, {
        preserveActivity: state.replyOperationRunState.heartbeat !== undefined,
      });
      return {
        queuedFinal: false,
        routedFinalCount: 0,
        suppressionReason: preparation.reason,
      };
    }
    const payload = renderPostCompactionModelFailurePayload(preparation.payload);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const expectedWriterRunId = normalizeOptionalString(params.replyOptions?.runId);
    const expectedLifecycleRevision = sessionStoreEntry.entry?.lifecycleRevision;
    const sourceReplySessionBinding = resolvePreparedTranscriptBinding(
      payloadMetadata?.sourceReplyTranscriptMirror?.sessionKey,
    );
    let sourceReplyTranscriptMirror: Parameters<
      typeof mirrorDeliveredReplyToTranscript
    >[0]["metadata"] = payloadMetadata?.sourceReplyTranscriptMirror
      ? {
          ...payloadMetadata.sourceReplyTranscriptMirror,
          ...(sourceReplySessionBinding
            ? { expectedSessionId: sourceReplySessionBinding.sessionId }
            : {}),
          ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
          ...(expectedWriterRunId ? { expectedWriterRunId } : {}),
          storePath: sourceReplySessionBinding?.storePath ?? sessionStoreEntry.storePath,
        }
      : undefined;
    const hasTranscriptOwner =
      payloadMetadata?.assistantMessageIndex !== undefined ||
      payloadMetadata?.assistantTranscriptOwned === true;
    const hasVisibleFinalContent = hasOutboundReplyContent(payload, { trimText: true });
    if (hasVisibleFinalContent) {
      markInboundDedupeReplayUnsafe();
      finalReplyDeliveryStarted = true;
    }
    const shouldAttachDeferredText = deferFinalTtsText && isCaptionedFinalTextPayload(payload);
    const deferredRawText = shouldAttachDeferredText
      ? mergeDeferredFinalText(options.deferredTtsText ?? "", payload.text)
      : undefined;
    const ttsInputPayload = shouldAttachDeferredText
      ? copyReplyPayloadMetadata(payload, {
          ...payload,
          text: deferredRawText,
        })
      : payload;
    const deferredVisibleText = shouldAttachDeferredText
      ? cleanDeferredFinalDirectives
        ? cleanDeferredFinalText(deferredRawText)
        : deferredRawText
      : undefined;
    let appliedTtsPayload = payload;
    if (!options.skipTts && payload.isReasoning !== true && payload.isCommentary !== true) {
      try {
        appliedTtsPayload = await state.maybeApplyTtsWithFinalizationLease({
          payload: ttsInputPayload,
          cfg,
          channel: deliveryChannel,
          kind: "final",
          ttsAuto: sessionTtsAuto,
          agentId: sessionAgentId,
          accountId: replyRoute.accountId,
        });
      } catch (error) {
        if (!shouldAttachDeferredText) {
          throw error;
        }
        logVerbose(`dispatch-from-config: final TTS failed: ${formatErrorMessage(error)}`);
      }
    }
    const ttsPayload = shouldAttachDeferredText
      ? copyReplyPayloadMetadata(appliedTtsPayload, {
          ...appliedTtsPayload,
          text: deferredVisibleText || undefined,
        })
      : appliedTtsPayload;
    throwIfFinalDeliveryAborted();
    let normalizedPayload: ReplyPayload;
    try {
      normalizedPayload = await state.normalizeReplyMediaPayload(ttsPayload);
    } catch (error) {
      if (!shouldAttachDeferredText || !deferredVisibleText) {
        throw error;
      }
      logVerbose(`dispatch-from-config: media normalization failed: ${formatErrorMessage(error)}`);
      normalizedPayload = buildCaptionedFinalTextFallback(ttsPayload);
    }
    throwIfFinalDeliveryAborted();
    const block = await getBlockReplyOutcome(payload, abortSignal);
    throwIfFinalDeliveryAborted();
    const blockDeliveryOutcome = block?.outcome;
    const pendingBlock = block?.pending && blockDeliveryOutcome !== "delivered";
    if (blockDeliveryOutcome && (pendingBlock || !shouldRetryReplyDispatch(blockDeliveryOutcome))) {
      if (
        blockDeliveryOutcome === "channel-transform" ||
        (blockDeliveryOutcome === "failed-deliver" && !pendingBlock) ||
        createBlockReplyContentKey(normalizedPayload) === createBlockReplyContentKey(payload)
      ) {
        return { blockDeliveryOutcome, pendingBlock, queuedFinal: false, routedFinalCount: 0 };
      }
      // The block already owns the text. Preserve final-only media without
      // letting an audio receipt finalize the block's pending text completion.
      normalizedPayload = copyReplyPayloadMetadata(normalizedPayload, {
        ...normalizedPayload,
        text: undefined,
      });
      if (pendingBlock) {
        await suppressPendingFinalDelivery(payload, {
          preserveActivity: state.replyOperationRunState.heartbeat !== undefined,
        });
        setReplyPayloadMetadata(normalizedPayload, { pendingFinalDeliveryCompletion: undefined });
        sourceReplyTranscriptMirror = sourceReplyTranscriptMirror
          ? transcriptMirrorForDeliveredPayload(sourceReplyTranscriptMirror, normalizedPayload)
          : undefined;
      }
      if (!hasOutboundReplyContent(normalizedPayload, { trimText: true })) {
        return { blockDeliveryOutcome, pendingBlock, queuedFinal: false, routedFinalCount: 0 };
      }
    }
    if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
      return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
    }
    let result = await state.routeReplyToOriginating(normalizedPayload, {
      abortSignal,
      kind: "final",
      ...(hasTranscriptOwner ? { mirror: false } : {}),
    });
    if (result) {
      let routedOutcome = resolveRoutedReplyDeliveryOutcome(result);
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
        );
      }
      const fallbackText =
        deferFinalTtsText && normalizedPayload.mediaUrl
          ? normalizeOptionalString(normalizedPayload.text)
          : undefined;
      if (fallbackText && shouldRetryReplyDispatch(routedOutcome)) {
        if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
          return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
        }
        result =
          (await state.routeReplyToOriginating(
            copyReplyPayloadMetadata(normalizedPayload, { text: fallbackText }),
            {
              abortSignal,
              kind: "final",
              ...(hasTranscriptOwner ? { mirror: false } : {}),
            },
          )) ?? result;
        routedOutcome = resolveRoutedReplyDeliveryOutcome(result);
      }
      if (isRoutedReplyDelivered(result)) {
        await mirrorDeliveredReplyToTranscript({
          metadata: sourceReplyTranscriptMirror,
          cfg,
        });
      }
      return {
        pendingBlock,
        queuedFinal: result.ok,
        routedFinalCount: isRoutedReplyDelivered(result) ? 1 : 0,
        routedOutcome,
        ...(result.reason === "channel_transform"
          ? { suppressionReason: "channel_transform" as const }
          : {}),
      };
    }
    throwIfFinalDeliveryAborted();
    const transcriptMirrorSessionKey =
      acpDispatchSessionKey ?? sessionStoreEntry.sessionKey ?? sessionKey;
    const transcriptMirrorSourceId =
      normalizeOptionalString(state.messageIdForHook) ??
      normalizeOptionalString(params.replyOptions?.runId);
    const transcriptMirrorSessionBinding = resolvePreparedTranscriptBinding(
      transcriptMirrorSessionKey,
    );
    const transcriptMirror =
      sourceReplyTranscriptMirror ??
      (state.normalizedCurrentSurface === "slack" &&
      hasVisibleFinalContent &&
      transcriptMirrorSessionKey
        ? transcriptMirrorForDeliveredPayload(
            {
              sessionKey: transcriptMirrorSessionKey,
              agentId: sessionAgentId,
              ...(transcriptMirrorSessionBinding
                ? { expectedSessionId: transcriptMirrorSessionBinding.sessionId }
                : {}),
              ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
              ...(expectedWriterRunId ? { expectedWriterRunId } : {}),
              storePath: transcriptMirrorSessionBinding?.storePath ?? sessionStoreEntry.storePath,
              preferText: true,
              ...(hasTranscriptOwner ? { transcriptOwner: true } : {}),
              idempotencyKey: transcriptMirrorSourceId
                ? `channel-final:${transcriptMirrorSourceId}:${options.deliveryId ?? "single"}`
                : undefined,
              deliveryMirror: {
                kind: "channel-final",
                ...(transcriptMirrorSourceId ? { sourceMessageId: transcriptMirrorSourceId } : {}),
              },
            },
            normalizedPayload,
          )
        : undefined);
    if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
      return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
    }
    markInboundDedupeReplayUnsafe();
    const finalDeliveryCapture = transcriptMirror ? {} : undefined;
    const deliveredTranscriptMirror = transcriptMirror
      ? captureDeliveredTranscriptMirror({
          dispatcher,
          metadata: transcriptMirror,
          captureToken: finalDeliveryCapture,
        })
      : undefined;
    if (finalDeliveryCapture) {
      setReplyPayloadMetadata(normalizedPayload, { finalDeliveryCapture });
    }
    if (deferFinalTtsText && normalizedPayload.mediaUrl && normalizedPayload.text?.trim()) {
      attachReplyDispatchUndeliveredFallback(
        normalizedPayload,
        buildCaptionedFinalTextFallback(normalizedPayload),
      );
    }
    const { queued: queuedFinal, outcome: dispatcherOutcome } = turnLedger.sendQueued(
      "final",
      normalizedPayload,
    );
    if (queuedFinal && deliveredTranscriptMirror && dispatcherOutcome) {
      // The common settle owner runs this after successful delivery or
      // cancellation. Keeping reconciliation out of the reply operation avoids
      // creating another operation/idle cycle during delivery settlement.
      registerReplyDispatcherSettledTask(dispatcher, () =>
        mirrorTranscriptAfterDispatcherSettled({
          outcome: dispatcherOutcome,
          metadata: deliveredTranscriptMirror,
          cfg,
        }),
      );
    }
    return {
      pendingBlock,
      queuedFinal,
      routedFinalCount: 0,
      ...(queuedFinal && dispatcherOutcome ? { dispatcherOutcome } : {}),
    };
  };

  // Run before_dispatch hook — let plugins inspect or handle before model dispatch.
  if (
    state.allowInboundHandlers &&
    runtimeTakeoverHooksAllowed(params.replyOptions?.admittedSessionSettings) &&
    hookRunner?.hasHooks("before_dispatch")
  ) {
    // This outer lookup key is resolved from the routed context; fields inside
    // sessionStoreEntry.entry cannot redirect hook or requester lineage.
    const beforeDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
    const pluginSubagentRequester = createPluginSubagentRequesterContext({
      sessionKey: beforeDispatchSessionKey,
      origin: {
        channel: routeReplyChannel,
        to: routeReplyTo,
        accountId: replyContextAccountId,
        threadId: routeReplyThreadId,
      },
    });
    const beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () =>
      runWithDispatchLifecycleAdmission(
        async () =>
          await runWithDispatchAbortSignal(
            getPreDispatchAbortSignal(),
            () =>
              hookRunner.runBeforeDispatch(
                {
                  messageId: state.hookState.hookContext.messageId,
                  content: state.hookState.hookContext.content,
                  body:
                    state.hookState.hookContext.bodyForAgent ?? state.hookState.hookContext.body,
                  channel: state.hookState.hookContext.channelId,
                  sessionKey: beforeDispatchSessionKey,
                  senderId: state.hookState.hookContext.senderId,
                  replyToId: state.hookState.hookContext.replyToId,
                  replyToIdFull: state.hookState.hookContext.replyToIdFull,
                  replyToBody: state.hookState.hookContext.replyToBody,
                  replyToSender: state.hookState.hookContext.replyToSender,
                  replyToIsQuote: state.hookState.hookContext.replyToIsQuote,
                  isGroup: state.hookState.hookContext.isGroup,
                  timestamp: state.hookState.hookContext.timestamp,
                },
                {
                  messageId: state.hookState.hookContext.messageId,
                  channelId: state.hookState.hookContext.channelId,
                  accountId: state.hookState.hookContext.accountId,
                  conversationId: state.hookState.inboundClaimContext.conversationId,
                  sessionKey: beforeDispatchSessionKey,
                  senderId: state.hookState.hookContext.senderId,
                  replyToId: state.hookState.hookContext.replyToId,
                  replyToIdFull: state.hookState.hookContext.replyToIdFull,
                  replyToBody: state.hookState.hookContext.replyToBody,
                  replyToSender: state.hookState.hookContext.replyToSender,
                  replyToIsQuote: state.hookState.hookContext.replyToIsQuote,
                },
                pluginSubagentRequester,
              ),
            trackDispatchLifecycleWork,
          ),
      ),
    );
    if (beforeDispatchResult?.handled) {
      const text = beforeDispatchResult.text;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (text && !state.suppressDelivery) {
        const handledReply = await sendFinalPayload(
          { text },
          {
            abortSignal: getPreDispatchAbortSignal(),
            deliveryId: "before-dispatch",
          },
        );
        queuedFinal = handledReply.queuedFinal;
        routedFinalCount += handledReply.routedFinalCount;
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "before_dispatch_handled" });
      markIdle("message_completed");
      commitInboundDedupeIfClaimed();
      completeDispatchReplyOperation();
      return {
        status: "complete" as const,
        result: attachSourceReplyDeliveryMode({ queuedFinal, counts }),
      };
    }
  }

  const restrictedRuntimeRefusal = await maybeRefuseRestrictedRuntimeTakeover({
    state,
    sendFinalPayload,
  });
  if (restrictedRuntimeRefusal) {
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode(restrictedRuntimeRefusal),
    };
  }

  const replyDispatchTakeover = await runReplyDispatchTakeover(state, shouldSendToolSummaries);
  if (replyDispatchTakeover) {
    return replyDispatchTakeover;
  }

  const dispatchAcquisition = await state.ensureDispatchReplyOperation(
    state.activeRunSafeCommandTurn ? "command_resolution" : "dispatch",
  );
  if (dispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
  }
  if (dispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: state.finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
    };
  }
  const nextState = extendPreparedDispatchState(state, {
    shouldSuppressDefaultToolProgressMessages,
    shouldSendVerboseProgressMessages,
    shouldSendToolSummaries,
    notifySessionMetadataChanges,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    sendTrackedBlockReply,
    recordRoutedBlockReplyDelivery,
    sendFinalPayload,
    isSessionWriterDeliveryAuthorized,
    deferFinalTtsText,
    routeState,
  });
  return { status: "ready" as const, state: nextState };
}

type ChooseDispatchRouteResult = Awaited<ReturnType<typeof chooseDispatchRoute>>;
export type ChooseDispatchRouteReadyState = Extract<
  ChooseDispatchRouteResult,
  { status: "ready" }
>["state"];
