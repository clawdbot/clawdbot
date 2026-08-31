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
import { createReplyDispatchEvent } from "./dispatch-from-config.events.js";
import {
  hasExecApprovalPayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import { suppressPendingFinalDelivery } from "./dispatch-from-config.pending-final.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { createSessionMetadataChangeNotifier } from "./dispatch-from-config.session-metadata.js";
import {
  captureDeliveredTranscriptMirror,
  mirrorDeliveredReplyToTranscript,
  mirrorTranscriptAfterDispatcherSettled,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import type { NormalizeReplySkipReason } from "./normalize-reply.js";
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
  const shouldDeliverFastModeAutoProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied;
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
  const deliveredBlockContentKeys = new Set<string>();
  const blockDeliveryOutcomes = new Map<string, Array<Promise<ReplyDispatchDeliveryOutcome>>>();
  const sendTrackedBlockReply = (payload: ReplyPayload): boolean => {
    const contentKey = createBlockReplyContentKey(payload);
    const delivery = turnLedger.sendQueued("block", payload);
    if (!delivery.queued) {
      return false;
    }
    const outcome = delivery.outcome ?? Promise.resolve("delivered" as const);
    const outcomes = blockDeliveryOutcomes.get(contentKey);
    if (outcomes) {
      outcomes.push(outcome);
    } else {
      blockDeliveryOutcomes.set(contentKey, [outcome]);
    }
    return true;
  };
  const recordRoutedBlockReplyDelivery = (
    payload: ReplyPayload,
    result: Awaited<ReturnType<typeof sendPayloadAsync>>,
  ): void => {
    if (result && isRoutedReplyDelivered(result)) {
      deliveredBlockContentKeys.add(createBlockReplyContentKey(payload));
    }
  };
  const wasReplyDeliveredAsBlock = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
  ): Promise<boolean> => {
    const contentKey = createBlockReplyContentKey(payload);
    if (deliveredBlockContentKeys.has(contentKey)) {
      return true;
    }
    const outcomes = blockDeliveryOutcomes.get(contentKey);
    if (!outcomes) {
      return false;
    }
    blockDeliveryOutcomes.delete(contentKey);
    const settlement = Promise.all(outcomes).then((settledOutcomes) => ({
      kind: "settled" as const,
      outcomes: settledOutcomes,
    }));
    if (abortSignal?.aborted) {
      return false;
    }
    let removeAbortListener: (() => void) | undefined;
    const result = abortSignal
      ? await Promise.race([
          settlement,
          new Promise<{ kind: "aborted" }>((resolve) => {
            const onAbort = () => resolve({ kind: "aborted" });
            abortSignal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
          }),
        ]).finally(() => removeAbortListener?.())
      : await settlement;
    if (result.kind === "aborted") {
      return false;
    }
    const delivered = result.outcomes.some((outcome) => outcome === "delivered");
    if (delivered) {
      deliveredBlockContentKeys.add(contentKey);
    }
    return delivered;
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
    dedupedAgainstBlock?: boolean;
    queuedFinal: boolean;
    routedFinalCount: number;
    suppressionReason?: NormalizeReplySkipReason;
    sessionWriterDeliveryRevoked?: true;
    dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
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
      await suppressPendingFinalDelivery(inputPayload);
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
    const sourceReplyTranscriptMirror = payloadMetadata?.sourceReplyTranscriptMirror
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
    const deliveredAsBlock = await wasReplyDeliveredAsBlock(payload, abortSignal);
    throwIfFinalDeliveryAborted();
    if (deliveredAsBlock) {
      if (createBlockReplyContentKey(normalizedPayload) === createBlockReplyContentKey(payload)) {
        return { dedupedAgainstBlock: true, queuedFinal: false, routedFinalCount: 0 };
      }
      // Final-only transforms such as TTS still need delivery, but the block already
      // made the text visible. Preserve only the newly added media/rich payload.
      normalizedPayload = copyReplyPayloadMetadata(normalizedPayload, {
        ...normalizedPayload,
        text: undefined,
      });
      if (!hasOutboundReplyContent(normalizedPayload, { trimText: true })) {
        return { dedupedAgainstBlock: true, queuedFinal: false, routedFinalCount: 0 };
      }
    }
    if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
      return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
    }
    const result = await state.routeReplyToOriginating(normalizedPayload, {
      abortSignal,
      kind: "final",
      ...(hasTranscriptOwner ? { mirror: false } : {}),
    });
    if (result) {
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
        );
      }
      if (isRoutedReplyDelivered(result)) {
        await mirrorDeliveredReplyToTranscript({
          metadata: sourceReplyTranscriptMirror,
          cfg,
        });
      }
      const fallbackText =
        deferFinalTtsText && normalizedPayload.mediaUrl
          ? normalizeOptionalString(normalizedPayload.text)
          : undefined;
      if (fallbackText && !isRoutedReplyDelivered(result)) {
        if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
          return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
        }
        const fallbackResult = await state.routeReplyToOriginating(
          copyReplyPayloadMetadata(normalizedPayload, { text: fallbackText }),
          {
            abortSignal,
            kind: "final",
            ...(hasTranscriptOwner ? { mirror: false } : {}),
          },
        );
        if (fallbackResult && isRoutedReplyDelivered(fallbackResult)) {
          await mirrorDeliveredReplyToTranscript({
            metadata: sourceReplyTranscriptMirror,
            cfg,
          });
          return { queuedFinal: true, routedFinalCount: 1 };
        }
      }
      return {
        queuedFinal: result.ok,
        routedFinalCount: isRoutedReplyDelivered(result) ? 1 : 0,
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
      queuedFinal,
      routedFinalCount: 0,
      ...(queuedFinal && dispatcherOutcome ? { dispatcherOutcome } : {}),
    };
  };

  // Run before_dispatch hook — let plugins inspect or handle before model dispatch.
  if (hookRunner?.hasHooks("before_dispatch")) {
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

  if (hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })) {
    const replyDispatchResult = await traceReplyPhase("reply.reply_dispatch_hooks", () =>
      runWithDispatchLifecycleAdmission(
        async () =>
          await runWithDispatchAbortSignal(
            getPreDispatchAbortSignal(),
            () =>
              hookRunner.runReplyDispatch(
                createReplyDispatchEvent({
                  ctx,
                  runId: params.replyOptions?.runId,
                  sessionKey: acpDispatchSessionKey,
                  toolsAllow: params.replyOptions?.toolsAllow,
                  images: params.replyOptions?.images,
                  inboundAudio: state.inboundAudio,
                  sessionTtsAuto,
                  ttsChannel: deliveryChannel,
                  suppressUserDelivery: state.suppressHookUserDelivery,
                  suppressReplyLifecycle: state.suppressHookReplyLifecycle,
                  sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
                  shouldRouteToOriginating,
                  originatingChannel: routeReplyChannel,
                  originatingTo: routeReplyTo,
                  originatingAccountId: replyContextAccountId,
                  originatingThreadId: routeReplyThreadId,
                  originatingChatType: replyRoute.chatType,
                  shouldSendToolSummaries,
                  shouldSendFullToolDetails: state.shouldEmitFullVerboseProgress(),
                  sendPolicy: state.sendPolicy,
                }),
                {
                  cfg,
                  dispatchKind: state.dispatchKind,
                  dispatcher: state.dispatchHookDispatcher,
                  abortSignal: getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                  onReplyStart: params.replyOptions?.onReplyStart,
                  onAgentRunStart: params.replyOptions?.onAgentRunStart,
                  userTurnTranscriptRecorder: params.replyOptions?.userTurnTranscriptRecorder,
                  prepareAssistantTranscriptMessage:
                    params.replyOptions?.prepareAssistantTranscriptMessage,
                  recordProcessed,
                  markIdle,
                },
              ),
            trackDispatchLifecycleWork,
          ),
      ),
    );
    if (replyDispatchResult?.handled) {
      commitInboundDedupeIfClaimed();
      completeDispatchReplyOperation();
      return {
        status: "complete" as const,
        result: attachSourceReplyDeliveryMode({
          queuedFinal: replyDispatchResult.queuedFinal,
          counts: replyDispatchResult.counts,
        }),
      };
    }
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
    shouldDeliverFastModeAutoProgressDespiteSourceSuppression,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    sendTrackedBlockReply,
    recordRoutedBlockReplyDelivery,
    wasReplyDeliveredAsBlock,
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
