import {
  hasOutboundReplyContent,
  isFastModeAutoProgressPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { isAskUserPromptPending } from "../../agents/tools/ask-user-tool.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import type { BlockReplyContext } from "../get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../reply-payload.js";
import { buildTerminalAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  type InternalReplyResolverOptions,
  createReplyDispatchEvent,
} from "./dispatch-from-config.events.js";
import { shouldDeliverDespiteSourceReplySuppression } from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
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
    getDispatchAbortOperation,
    getDispatchAbortSignal,
    hasAskUserPayload,
    hookRunner,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    markVisibleToolErrorProgress,
    maybeApplyTtsWithFinalizationLease,
    normalizeReplyMediaPayload,
    notifySessionMetadataChanges,
    onToolResultFromReplyOptions,
    params,
    reasoningPayloadsEnabled,
    recordAgentDispatchCompleted,
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
    sourceReplyDeliveryMode,
    trackDispatchLifecycleWork,
    typing,
    wasReplyDeliveredAsBlock,
    waitForPendingDirectBlockReplyDelivery,
    wrapProgressCallback,
  } = state;
  let deliberateSilentTerminalReply = false;
  let pendingContinuation = false;
  let didDeliverVisiblePartialReply = false;
  const flushDeferredFinalText = async () => {
    if (!deferFinalTtsText || params.replyOptions?.isHeartbeat === true) {
      return false;
    }
    const deferredVisibleText = cleanBlockTtsDirectiveText
      ? cleanDeferredFinalText(state.progressState.accumulatedBlockTtsText)
      : state.progressState.accumulatedBlockText;
    if (!deferredVisibleText.trim()) {
      return false;
    }
    const fallback = await sendFinalPayload(
      { text: deferredVisibleText },
      { abortSignal: isDispatchOperationAborted() ? false : undefined, skipTts: true },
    );
    if (!fallback.queuedFinal && fallback.routedFinalCount === 0) {
      return false;
    }
    didDeliverVisiblePartialReply = true;
    state.progressState.accumulatedBlockText = "";
    state.progressState.accumulatedBlockTtsText = "";
    return true;
  };
  const replyResult = await runWithDispatchLifecycleAdmission(
    async () =>
      await runWithDispatchAbortSignal(
        getDispatchAbortSignal(),
        () =>
          state.traceReplyPhase("reply.run_reply_resolver", () =>
            state.replyResolver(
              ctx,
              {
                ...state.getReplyOptions(),
                [REPLY_OPERATION_RUN_STATE]: state.replyOperationRunState,
                sourceReplyDeliveryMode,
                sessionPromptSourceReplyDeliveryMode: state.sessionStableSourceReplyDeliveryMode,
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
                shouldSuppressToolErrorWarnings: state.shouldSuppressToolErrorWarnings,
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
                  onVisible: (payload) => {
                    if (state.hasFailedProgressStatus(payload)) {
                      markVisibleToolErrorProgress();
                    }
                  },
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
                onToolResult: (payload: ReplyPayload) => {
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
                    // When the operator opts into messages.suppressToolErrors, never
                    // surface tool-error tool-result payloads as channel progress,
                    // regardless of source delivery mode. payloads.ts already drops
                    // the warning text; this drops the visible progress delivery too.
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
                    const progressCallbackForwarded = state.shouldForwardToolResultProgressCallback(
                      payload,
                      isFastModeAutoProgress,
                    );
                    if (progressCallbackForwarded) {
                      await onToolResultFromReplyOptions?.(payload);
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      isFastModeAutoProgress &&
                      progressCallbackForwarded &&
                      onToolResultFromReplyOptions
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
                    const visibleToolPayload = isForcedToolProgress
                      ? payload
                      : resolveToolDeliveryPayload(payload);
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
                      const hasMedia = resolveSendableOutboundReplyParts(deliveryPayload).hasMedia;
                      if (
                        !hasMedia &&
                        !state.hasExecApprovalPayload(deliveryPayload) &&
                        !hasAskUserPayload(deliveryPayload)
                      ) {
                        return;
                      }
                    }
                    if (deliveryPayload.isError === true) {
                      markVisibleToolErrorProgress();
                    }
                    const askUserQuestionId = state.readAskUserQuestionId(deliveryPayload);
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
                      markInboundDedupeReplayUnsafe();
                      const delivered = state.turnLedger.sendQueued("tool", deliveryPayload).queued;
                      if (delivered && hasAskUserPayload(deliveryPayload)) {
                        // ask_user blocks until this callback resolves; drain its prompt now
                        // or the answerable UI can remain queued behind the blocked agent run.
                        await waitForReplyDispatcherIdle(
                          dispatcher,
                          getDispatchAbortOperation()?.abortSignal,
                        );
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
                onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => {
                  markProgress();
                  const run = async () => {
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      payload.isReasoning !== true &&
                      payload.isCommentary !== true &&
                      hasOutboundReplyContent(payload, { trimText: true })
                    ) {
                      markInboundDedupeReplayUnsafe();
                    }
                    // Buffered commentary preceded this block; deliver it first.
                    await flushPendingCommentaryProgress();
                    if (
                      state.suppressDelivery &&
                      !shouldDeliverDespiteSourceReplySuppression(payload, state)
                    ) {
                      return;
                    }
                    // Durable reasoning is a channel-owned lane; generic channels
                    // keep the historical suppression unless they explicitly opt in.
                    if (payload.isReasoning === true && !reasoningPayloadsEnabled) {
                      return;
                    }
                    // Durable commentary is a channel-owned lane; generic channels keep the
                    // historical suppression unless they explicitly opt in.
                    if (payload.isCommentary === true && !commentaryPayloadsEnabled) {
                      return;
                    }
                    // Accumulate block text for TTS generation after streaming.
                    // Exclude status notices — they are informational UI signals
                    // and must not be synthesised into the spoken reply. Display
                    // lanes stay out too: they are presentation, never final text.
                    const isStatusNotice = isReplyPayloadStatusNotice(payload);
                    if (
                      payload.text &&
                      !isStatusNotice &&
                      payload.isReasoning !== true &&
                      payload.isCommentary !== true
                    ) {
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
                      payload.text &&
                      cleanBlockTtsDirectiveText &&
                      !isStatusNotice &&
                      payload.isReasoning !== true &&
                      payload.isCommentary !== true
                        ? (() => {
                            const text = cleanBlockTtsDirectiveText.push(payload.text);
                            return copyReplyPayloadMetadata(payload, {
                              ...payload,
                              text: text.trim() ? text : undefined,
                            });
                          })()
                        : payload;
                    const deferThisBlock =
                      deferFinalTtsText &&
                      !isStatusNotice &&
                      payload.isReasoning !== true &&
                      payload.isCommentary !== true;
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
                    if (shouldRouteToOriginating) {
                      const result = await sendPayloadAsync(
                        normalizedPayload,
                        context?.abortSignal,
                        false,
                        "block",
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
                        );
                      }
                    }
                  };
                  return run();
                },
              },
              replyConfig,
            ),
          ),
        trackDispatchLifecycleWork,
      ),
  ).catch(async (error: unknown) => {
    try {
      await flushDeferredFinalText();
    } catch (fallbackError) {
      logVerbose(
        `dispatch-from-config: deferred final text fallback failed: ${formatErrorMessage(fallbackError)}`,
      );
    }
    if (
      params.replyOptions?.isHeartbeat === true ||
      !didDeliverVisiblePartialReply ||
      isDispatchOperationAborted()
    ) {
      throw error;
    }
    failDispatchReplyOperation(error);
    return buildTerminalAgentRunFailureReplyPayload({
      visibleReplyDelivered: true,
      sessionCtx: ctx,
      cfg: replyConfig,
    });
  });
  if (isDispatchOperationAborted()) {
    try {
      await flushDeferredFinalText();
    } catch (fallbackError) {
      logVerbose(
        `dispatch-from-config: deferred final text fallback failed: ${formatErrorMessage(fallbackError)}`,
      );
    }
  }
  const sessionMetadataChanges = takeCommandSessionMetadataChanges(ctx);
  notifySessionMetadataChanges(sessionMetadataChanges);
  const finalDispatchAcquisition = await state.ensureDispatchReplyOperation("dispatch");
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

  if (ctx.AcpDispatchTailAfterReset === true) {
    // Command handling prepared a trailing prompt after ACP in-place reset.
    // Route that tail through ACP now (same turn) instead of embedded dispatch.
    ctx.AcpDispatchTailAfterReset = false;
    if (hookRunner?.hasHooks("reply_dispatch")) {
      const tailDispatchResult = await runWithDispatchLifecycleAdmission(
        async () =>
          await runWithDispatchAbortSignal(
            getDispatchAbortSignal(),
            () =>
              hookRunner.runReplyDispatch(
                createReplyDispatchEvent({
                  ctx,
                  runId: params.replyOptions?.runId,
                  sessionKey: state.acpDispatchSessionKey,
                  toolsAllow: params.replyOptions?.toolsAllow,
                  images: params.replyOptions?.images,
                  inboundAudio: state.inboundAudio,
                  sessionTtsAuto,
                  ttsChannel: deliveryChannel,
                  suppressUserDelivery: state.suppressHookUserDelivery,
                  suppressReplyLifecycle: state.suppressHookReplyLifecycle,
                  sourceReplyDeliveryMode,
                  shouldRouteToOriginating,
                  originatingChannel: state.routeReplyChannel,
                  originatingTo: state.routeReplyTo,
                  originatingAccountId: state.replyContextAccountId,
                  originatingThreadId: state.routeReplyThreadId,
                  originatingChatType: replyRoute.chatType,
                  shouldSendToolSummaries: state.shouldSendToolSummaries,
                  sendPolicy: state.sendPolicy,
                  isTailDispatch: true,
                }),
                {
                  cfg,
                  dispatcher: state.dispatchHookDispatcher,
                  abortSignal:
                    state.getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                  onReplyStart: params.replyOptions?.onReplyStart,
                  recordProcessed: state.recordProcessed,
                  markIdle: state.markIdle,
                },
              ),
            trackDispatchLifecycleWork,
          ),
      );
      if (tailDispatchResult?.handled) {
        recordAgentDispatchCompleted("completed");
        state.completeDispatchReplyOperation();
        return {
          status: "complete" as const,
          result: state.attachSourceReplyDeliveryMode({
            queuedFinal: tailDispatchResult.queuedFinal,
            counts: tailDispatchResult.counts,
            ...(state.routeState.sessionMetadataChangesForResult
              ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
              : {}),
          }),
        };
      }
    }
  }
  const nextState = extendPreparedDispatchState(state, {
    deliberateSilentTerminalReply,
    pendingContinuation,
    replyResult,
  });
  return { status: "ready" as const, state: nextState };
}

type ExecuteDispatchResult = Awaited<ReturnType<typeof executeDispatch>>;
export type ExecuteDispatchReadyState = Extract<
  ExecuteDispatchResult,
  { status: "ready" }
>["state"];
