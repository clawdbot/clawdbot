import {
  hasOutboundReplyContent,
  isFastModeAutoProgressPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { isAskUserPromptPending } from "../../agents/tools/ask-user-tool.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isCommandReplyForDelivery,
  isReplyPayloadStatusNotice,
  readAskUserQuestionId,
} from "../reply-payload.js";
import { buildTerminalAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { handleAcpDispatchTailAfterReset } from "./dispatch-from-config.acp-tail.js";
import type { InternalReplyResolverOptions } from "./dispatch-from-config.events.js";
import {
  hasAskUserPayload,
  prepareReplyPayloadForSideEffects as preparePayload,
  requiresDurableToolResultDelivery,
  shouldDeliverDespiteSourceReplySuppression,
} from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import { requireQueuedReplyDelivery } from "./dispatch-from-config.turn-ledger.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply-operation-run-state.js";

export async function executeDispatch(state: PrepareDispatchExecutionReadyState) {
  const {
    cfg,
    cleanBlockTtsDirectiveText,
    commentaryPayloadsEnabled,
    ctx,
    deliveryChannel,
    deferFinalTtsText,
    dispatcher,
    failDispatchReplyOperation,
    flushPendingCommentaryProgress,
    getAgentRunTerminalOutcome,
    getDispatchAbortOperation,
    getDispatchAbortSignal,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    maybeApplyTtsWithFinalizationLease,
    normalizeReplyMediaPayload,
    notifySessionMetadataChanges,
    onToolResultFromReplyOptions,
    params,
    reasoningPayloadsEnabled,
    replyConfig,
    replyRoute,
    resolveToolDeliveryPayload,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sendFinalPayload,
    sessionAgentId,
    sessionTtsAuto,
    shouldForwardProgressCallback,
    shouldRouteToOriginating,
    shouldSuppressDefaultToolProgressMessages,
    trackDispatchLifecycleWork,
    typing,
    wasReplyDeliveredAsBlock,
    waitForPendingDirectBlockReplyDelivery,
    wrapProgressCallback,
  } = state;
  // Bind at invocation so every public resolver consumes the request generation without widening its Plugin SDK contract.
  const replyResolver = bindPreparedReplyDispatchRuntime(
    params.configOverride ? undefined : state.preparedReplyDispatchRuntime,
    state.replyResolver,
  );
  let deliberateSilentTerminalReply = false;
  let pendingContinuation = false;
  let didDeliverVisiblePartialReply = false;
  const flushDeferredFinalText = async () => {
    try {
      if (!deferFinalTtsText || params.replyOptions?.isHeartbeat === true) {
        return;
      }
      const deferredVisibleText = cleanBlockTtsDirectiveText
        ? cleanDeferredFinalText(state.progressState.accumulatedBlockTtsText)
        : state.progressState.accumulatedBlockText;
      if (!deferredVisibleText.trim()) {
        return;
      }
      const fallback = await sendFinalPayload(
        { text: deferredVisibleText },
        { abortSignal: isDispatchOperationAborted() ? false : undefined, skipTts: true },
      );
      if (!fallback.queuedFinal && fallback.routedFinalCount === 0) {
        return;
      }
      didDeliverVisiblePartialReply = true;
      state.progressState.accumulatedBlockText = "";
      state.progressState.accumulatedBlockTtsText = "";
    } catch (fallbackError) {
      // Recovery must not replace the original resolver or cancellation outcome.
      logVerbose(
        `dispatch-from-config: deferred final text fallback failed: ${formatErrorMessage(fallbackError)}`,
      );
    }
  };
  const replyResult = await runWithDispatchLifecycleAdmission(
    async () =>
      await runWithDispatchAbortSignal(
        getDispatchAbortSignal(),
        () =>
          state.traceReplyPhase("reply.run_reply_resolver", () =>
            replyResolver(
              ctx,
              {
                ...state.getReplyOptions(),
                [REPLY_OPERATION_RUN_STATE]: state.replyOperationRunState,
                sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
                sessionPromptSourceReplyDeliveryMode: state.sessionStableSourceReplyDeliveryMode,
                ...state.sourceReplyDeliveryRuntimeOptions,
                ...({
                  onDeliberateSilentTerminalReply: () => {
                    deliberateSilentTerminalReply = true;
                  },
                  onPendingContinuation: () => {
                    pendingContinuation = true;
                  },
                  onSessionMetadataChanges: notifySessionMetadataChanges,
                  onSessionPrepared: state.notePreparedSession,
                } satisfies InternalReplyResolverOptions),
                onObservedReplyDelivery: state.markObservedReplyDelivery,
                suppressToolErrorWarnings: state.suppressToolErrorWarnings,
                typingPolicy: typing.typingPolicy,
                suppressTyping: typing.suppressTyping,
                onPartialReply: deferFinalTtsText
                  ? undefined
                  : wrapProgressCallback(params.replyOptions?.onPartialReply, {
                      onVisible: (payload) => {
                        if (hasOutboundReplyContent(payload, { trimText: true })) {
                          didDeliverVisiblePartialReply = true;
                        }
                      },
                    }),
                onReasoningStream: wrapProgressCallback(params.replyOptions?.onReasoningStream),
                streamReasoningInNonStreamModes:
                  params.replyOptions?.streamReasoningInNonStreamModes,
                onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
                onAssistantMessageStart: wrapProgressCallback(
                  params.replyOptions?.onAssistantMessageStart,
                ),
                onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
                onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                  onForward: async () => {
                    // Commentary precedes the tool that follows it.
                    await flushPendingCommentaryProgress();
                  },
                }),
                onItemEvent: state.onItemEvent,
                commentaryProgressEnabled:
                  state.deliverStandaloneCommentaryProgress ||
                  state.canForwardSuppressedSourceItemEvents ||
                  params.replyOptions?.commentaryProgressEnabled,
                reasoningPayloadsEnabled,
                commentaryPayloadsEnabled,
                onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput, {
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onToolResult: (payload) => {
                  state.getDispatchReplyOperation()?.recordActivity();
                  markProgress();
                  const run = async () => {
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    await waitForPendingDirectBlockReplyDelivery(
                      getDispatchAbortOperation()?.abortSignal,
                    );
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markInboundDedupeReplayUnsafe();
                    // Buffered commentary preceded this tool; land it before the summary.
                    await flushPendingCommentaryProgress();
                    // Tool-error suppression covers visible progress and warnings regardless of source delivery mode.
                    if (
                      payload.isError === true &&
                      replyConfig.messages?.suppressToolErrors === true
                    ) {
                      return;
                    }
                    const isFastModeAutoProgress = isFastModeAutoProgressPayload(payload);
                    const isFastModeAutoProgressDelivery =
                      isFastModeAutoProgress &&
                      state.shouldDeliverFastModeAutoProgressDespiteSourceSuppression();
                    const isForcedToolProgress =
                      state.shouldDeliverForcedToolProgressDespiteSourceSuppression();
                    const forceToolResultProgress =
                      params.replyOptions?.forceToolResultProgress === true;
                    const durableToolResult = requiresDurableToolResultDelivery(payload);
                    const requiresDurableToolResult = forceToolResultProgress && durableToolResult;
                    if (params.replyOptions?.suppressToolProgressMessages && !durableToolResult) {
                      return;
                    }
                    const shouldForwardToolResultProgress = isFastModeAutoProgress
                      ? shouldForwardProgressCallback({
                          forwardWhenSourceDeliverySuppressed: true,
                        })
                      : forceToolResultProgress
                        ? !requiresDurableToolResult &&
                          !state.shouldEmitVerboseProgress() &&
                          shouldForwardProgressCallback({
                            forwardWhenSourceDeliverySuppressed: true,
                          })
                        : state.shouldSendToolSummaries() && shouldForwardProgressCallback();
                    const toolResultProgressCallback = shouldForwardToolResultProgress
                      ? onToolResultFromReplyOptions
                      : undefined;
                    if (toolResultProgressCallback) {
                      await toolResultProgressCallback(payload);
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      toolResultProgressCallback &&
                      (isFastModeAutoProgress || forceToolResultProgress)
                    ) {
                      return;
                    }
                    if (state.sendPolicyDenied) {
                      return;
                    }
                    if (
                      state.shouldSuppressProgressDelivery() &&
                      !isFastModeAutoProgressDelivery &&
                      !isForcedToolProgress &&
                      !hasAskUserPayload(payload)
                    ) {
                      return;
                    }
                    const visibleToolPayload = preparePayload(
                      dispatcher,
                      "tool",
                      isForcedToolProgress ? payload : resolveToolDeliveryPayload(payload),
                      state.progressState,
                    );
                    if (!visibleToolPayload) {
                      return;
                    }
                    const ttsPayload = await maybeApplyTtsWithFinalizationLease({
                      payload: visibleToolPayload,
                      cfg,
                      channel: deliveryChannel,
                      kind: "tool",
                      ttsAuto: sessionTtsAuto,
                      agentId: sessionAgentId,
                      accountId: replyRoute.accountId,
                    });
                    const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
                    const deliveryPayload = isForcedToolProgress
                      ? normalizedPayload
                      : resolveToolDeliveryPayload(normalizedPayload);
                    if (!deliveryPayload) {
                      return;
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      state.shouldSuppressLateTextOnlyToolProgress(deliveryPayload) &&
                      !isFastModeAutoProgressPayload(deliveryPayload) &&
                      !isForcedToolProgress
                    ) {
                      return;
                    }
                    if (state.shouldSuppressMessageToolOnlyTextErrorProgress(deliveryPayload)) {
                      return;
                    }
                    if (
                      shouldSuppressDefaultToolProgressMessages() &&
                      !isFastModeAutoProgressPayload(deliveryPayload) &&
                      !isForcedToolProgress
                    ) {
                      if (!requiresDurableToolResultDelivery(deliveryPayload)) {
                        return;
                      }
                    }
                    const askUserQuestionId = readAskUserQuestionId(deliveryPayload);
                    if (
                      askUserQuestionId !== undefined &&
                      !(await isAskUserPromptPending(askUserQuestionId))
                    ) {
                      return;
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (shouldRouteToOriginating) {
                      await sendPayloadAsync(deliveryPayload, undefined, false);
                    } else {
                      const delivery = state.turnLedger.sendQueued("tool", deliveryPayload);
                      if (hasAskUserPayload(deliveryPayload)) {
                        await requireQueuedReplyDelivery({
                          delivery,
                          dispatcher,
                          abortSignal: getDispatchAbortOperation()?.abortSignal,
                        });
                      }
                    }
                  };
                  return run();
                },
                onPlanUpdate: async (payload) => {
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  const steps = normalizeAgentPlanSteps(payload.steps);
                  const normalized = {
                    phase: payload.phase,
                    title: payload.title,
                    explanation: payload.explanation,
                    steps,
                    source: payload.source,
                  };
                  markProgress();
                  await waitForPendingDirectBlockReplyDelivery(
                    getDispatchAbortOperation()?.abortSignal,
                  );
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markInboundDedupeReplayUnsafe();
                  if (
                    shouldForwardProgressCallback({
                      forwardWhenSourceDeliverySuppressed: true,
                      requiresToolSummaryVisibility: true,
                    })
                  ) {
                    await state.onPlanUpdateFromReplyOptions?.(normalized);
                  }
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  if (payload.phase !== "update" || shouldSuppressDefaultToolProgressMessages()) {
                    return;
                  }
                  await state.sendPlanUpdate({
                    explanation: normalized.explanation,
                    steps,
                  });
                },
                onApprovalEvent: async (payload) => {
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markProgress();
                  await waitForPendingDirectBlockReplyDelivery(
                    getDispatchAbortOperation()?.abortSignal,
                  );
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markInboundDedupeReplayUnsafe();
                  if (
                    shouldForwardProgressCallback({
                      forwardWhenSourceDeliverySuppressed: true,
                      requiresToolSummaryVisibility: true,
                    })
                  ) {
                    await state.onApprovalEventFromReplyOptions?.(payload);
                  }
                },
                onPatchSummary: async (payload) => {
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markProgress();
                  await waitForPendingDirectBlockReplyDelivery(
                    getDispatchAbortOperation()?.abortSignal,
                  );
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markInboundDedupeReplayUnsafe();
                  if (
                    shouldForwardProgressCallback({
                      forwardWhenSourceDeliverySuppressed: true,
                      requiresToolSummaryVisibility: true,
                    })
                  ) {
                    await state.onPatchSummaryFromReplyOptions?.(payload);
                  }
                },
                onBlockReply: (inputPayload, context) => {
                  markProgress();
                  const run = async () => {
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    // Buffered commentary preceded this block; deliver it first.
                    await flushPendingCommentaryProgress();
                    const independentDurableBlock = context?.deliveryIntentId !== undefined;
                    if (independentDurableBlock && state.suppressAcpChildUserDelivery) {
                      return;
                    }
                    if (
                      state.suppressDelivery &&
                      !shouldDeliverDespiteSourceReplySuppression(inputPayload, state)
                    ) {
                      return;
                    }
                    // Durable reasoning is a channel-owned lane; generic channels
                    // keep the historical suppression unless they explicitly opt in.
                    if (inputPayload.isReasoning === true && !reasoningPayloadsEnabled) {
                      return;
                    }
                    // Durable commentary is a channel-owned lane; generic channels keep the
                    // historical suppression unless they explicitly opt in.
                    if (inputPayload.isCommentary === true && !commentaryPayloadsEnabled) {
                      return;
                    }
                    const payload = preparePayload(
                      dispatcher,
                      "block",
                      inputPayload,
                      state.progressState,
                      markInboundDedupeReplayUnsafe,
                    );
                    if (!payload) {
                      return;
                    }
                    // Accumulate block text for TTS generation after streaming.
                    // Exclude status notices — they are informational UI signals
                    // and must not be synthesised into the spoken reply. Display
                    // lanes stay out too: they are presentation, never final text.
                    const isStatusNotice = isReplyPayloadStatusNotice(payload);
                    const contributesToFinalReply =
                      !isStatusNotice &&
                      !independentDurableBlock &&
                      payload.isReasoning !== true &&
                      payload.isCommentary !== true;
                    if (payload.text && contributesToFinalReply) {
                      const joinsBufferedTtsDirective =
                        cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
                      if (state.progressState.accumulatedBlockText.length > 0) {
                        state.progressState.accumulatedBlockText += "\n";
                      }
                      state.progressState.accumulatedBlockText += payload.text;
                      if (
                        state.progressState.accumulatedBlockTtsText.length > 0 &&
                        !joinsBufferedTtsDirective
                      ) {
                        state.progressState.accumulatedBlockTtsText += "\n";
                      }
                      state.progressState.accumulatedBlockTtsText += payload.text;
                      state.progressState.blockCount++;
                    }
                    let visiblePayload =
                      payload.text && cleanBlockTtsDirectiveText && contributesToFinalReply
                        ? (() => {
                            const text = cleanBlockTtsDirectiveText.push(payload.text);
                            return copyReplyPayloadMetadata(payload, {
                              ...payload,
                              text: text.trim() ? text : undefined,
                            });
                          })()
                        : payload;
                    const deferThisBlock = deferFinalTtsText && contributesToFinalReply;
                    if (deferThisBlock) {
                      const hasNonTextContent = Boolean(
                        visiblePayload.mediaUrl ||
                        visiblePayload.mediaUrls?.length ||
                        visiblePayload.presentation ||
                        visiblePayload.interactive ||
                        visiblePayload.channelData,
                      );
                      if (!hasNonTextContent) {
                        return;
                      }
                      visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
                        ...visiblePayload,
                        text: undefined,
                      });
                    }
                    if (!hasOutboundReplyContent(visiblePayload, { trimText: true })) {
                      return;
                    }
                    // Channels that keep a live draft preview may need to rotate their
                    // preview state at the logical block boundary before queued block
                    // delivery drains asynchronously through the dispatcher.
                    const payloadMetadata = getReplyPayloadMetadata(payload);
                    const queuedContext =
                      payloadMetadata?.assistantMessageIndex !== undefined
                        ? {
                            ...context,
                            assistantMessageIndex: payloadMetadata.assistantMessageIndex,
                          }
                        : context;
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    const ttsPayload =
                      payload.isReasoning === true || payload.isCommentary === true
                        ? visiblePayload
                        : await maybeApplyTtsWithFinalizationLease({
                            payload: visiblePayload,
                            cfg,
                            channel: deliveryChannel,
                            kind: "block",
                            ttsAuto: sessionTtsAuto,
                            agentId: sessionAgentId,
                            accountId: replyRoute.accountId,
                          });
                    const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      shouldRouteToOriginating ||
                      (independentDurableBlock && state.canRouteDurableBlockReply)
                    ) {
                      const result = await sendPayloadAsync(
                        normalizedPayload,
                        context?.abortSignal,
                        false,
                        "block",
                        context?.deliveryIntentId,
                      );
                      state.recordRoutedBlockReplyDelivery(normalizedPayload, result);
                      if (result?.delivered === true && !state.suppressAutomaticSourceDelivery) {
                        await params.replyOptions?.onBlockReplyQueued?.(
                          visiblePayload,
                          queuedContext,
                        );
                      }
                    } else {
                      markInboundDedupeReplayUnsafe();
                      const admitted = state.sendTrackedBlockReply(normalizedPayload);
                      if (admitted) {
                        state.progressState.hasPendingDirectBlockReplyDelivery = true;
                      }
                      if (
                        admitted &&
                        !state.suppressAutomaticSourceDelivery &&
                        params.replyOptions?.onBlockReplyQueued
                      ) {
                        // Block callbacks are delivery facts, not queue-admission facts.
                        // Resolve them after beforeDeliver hooks without stalling streaming.
                        trackDispatchLifecycleWork(
                          wasReplyDeliveredAsBlock(normalizedPayload, context?.abortSignal).then(
                            async (delivered) => {
                              if (delivered) {
                                await params.replyOptions?.onBlockReplyQueued?.(
                                  visiblePayload,
                                  queuedContext,
                                );
                              }
                            },
                          ),
                          "delivery",
                        );
                      }
                    }
                  };
                  return run();
                },
              },
              state.preparedReplyDispatchRuntime && !params.configOverride
                ? undefined
                : replyConfig,
            ),
          ),
        trackDispatchLifecycleWork,
      ),
  ).catch(async (error: unknown) => {
    await flushDeferredFinalText();
    const failedAgentRun = getAgentRunTerminalOutcome() === "failed";
    const adopted = state.turnAdoptionState?.adopted === true;
    if (
      params.replyOptions?.isHeartbeat === true ||
      (!failedAgentRun && !didDeliverVisiblePartialReply && !adopted) ||
      isDispatchOperationAborted()
    ) {
      throw error;
    }
    failDispatchReplyOperation(error, "failed");
    if (!didDeliverVisiblePartialReply) {
      // Adoption retires ingress replay before the model starts. A progress ACK
      // cannot settle a later failure; use normal final delivery and its policy.
      return adopted &&
        state.noVisibleReplyFallbackDirected &&
        !state.suppressDelivery &&
        !state.getObservedReplyDelivery()
        ? { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true }
        : undefined;
    }
    return buildTerminalAgentRunFailureReplyPayload({
      visibleReplyDelivered: true,
      sessionCtx: ctx,
      cfg: replyConfig,
    });
  });
  if (isDispatchOperationAborted()) {
    await flushDeferredFinalText();
  }
  const sessionMetadataChanges = takeCommandSessionMetadataChanges(ctx);
  notifySessionMetadataChanges(sessionMetadataChanges);
  const resolvedCommandReply = isCommandReplyForDelivery(replyResult);
  const finalDispatchAcquisition = resolvedCommandReply
    ? ({ status: "ready" } as const)
    : await state.ensureDispatchReplyOperation("dispatch");
  if (finalDispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
  }
  if (finalDispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: state.finishReplyOperationBusyDispatch({
        recordAgentDispatchCompleted: true,
        ...(state.routeState.sessionMetadataChangesForResult
          ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
          : {}),
      }),
    };
  }

  const acpTailResult = await handleAcpDispatchTailAfterReset(state);
  if (acpTailResult) {
    return acpTailResult;
  }
  const nextState = extendPreparedDispatchState(state, {
    deliberateSilentTerminalReply,
    pendingContinuation,
    replyResult,
  });
  return { status: "ready" as const, state: nextState };
}
