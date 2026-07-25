import {
  hasOutboundReplyContent,
  isFastModeAutoProgressPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { isAskUserPromptPending } from "../../agents/tools/ask-user-tool.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import type { BlockReplyContext } from "../get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../reply-payload.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  type InternalReplyResolverOptions,
  createReplyDispatchEvent,
} from "./dispatch-from-config.events.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";

export async function executeDispatch(state: PrepareDispatchExecutionReadyState) {
  const {
    acpDispatchSessionKey,
    attachSourceReplyDeliveryMode,
    canForwardSuppressedSourceItemEvents,
    cfg,
    cleanBlockTtsDirectiveText,
    commentaryPayloadsEnabled,
    completeDispatchReplyOperation,
    ctx,
    deliverStandaloneCommentaryProgress,
    deliveryChannel,
    dispatchHookDispatcher,
    dispatcher,
    ensureDispatchReplyOperation,
    finishReplyOperationAbortedDispatch,
    finishReplyOperationBusyDispatch,
    flushPendingCommentaryProgress,
    getDispatchAbortOperation,
    getDispatchAbortSignal,
    getDispatchReplyOperation,
    getPreDispatchAbortSignal,
    getReplyOptions,
    hasAskUserPayload,
    hasExecApprovalPayload,
    hasFailedProgressStatus,
    hookRunner,
    inboundAudio,
    isDispatchOperationAborted,
    markIdle,
    markInboundDedupeReplayUnsafe,
    markObservedReplyDelivery,
    markProgress,
    markVisibleToolErrorProgress,
    maybeApplyTtsWithFinalizationLease,
    maybeSendWorkingStatus,
    normalizeReplyMediaPayload,
    notePreparedSession,
    notifySessionMetadataChanges,
    onApprovalEventFromReplyOptions,
    onItemEvent,
    onPatchSummaryFromReplyOptions,
    onPlanUpdateFromReplyOptions,
    onToolResultFromReplyOptions,
    params,
    readAskUserQuestionId,
    reasoningPayloadsEnabled,
    recordAgentDispatchCompleted,
    recordProcessed,
    replyConfig,
    replyContextAccountId,
    replyResolver,
    replyRoute,
    resolveToolDeliveryPayload,
    routeReplyChannel,
    routeReplyThreadId,
    routeReplyTo,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sendPlanUpdate,
    sendPolicy,
    sendPolicyDenied,
    sessionAgentId,
    sessionStableSourceReplyDeliveryMode,
    sessionTtsAuto,
    shouldDeliverFastModeAutoProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    shouldForwardProgressCallback,
    shouldForwardToolResultProgressCallback,
    shouldRouteToOriginating,
    shouldSendToolSummaries,
    shouldSuppressDefaultToolProgressMessages,
    shouldSuppressLateTextOnlyToolProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    shouldSuppressProgressDelivery,
    shouldSuppressToolErrorWarnings,
    sourceReplyDeliveryMode,
    summarizeApprovalLabel,
    summarizePatchLabel,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookReplyLifecycle,
    suppressHookUserDelivery,
    suppressToolErrorWarnings,
    traceReplyPhase,
    trackDispatchLifecycleWork,
    typing,
    waitForPendingDirectBlockReplyDelivery,
    wrapProgressCallback,
  } = state;
  const replyResult = await runWithDispatchLifecycleAdmission(
    async () =>
      await runWithDispatchAbortSignal(
        getDispatchAbortSignal(),
        () =>
          traceReplyPhase("reply.run_reply_resolver", () =>
            replyResolver(
              ctx,
              {
                ...getReplyOptions(),
                sourceReplyDeliveryMode,
                sessionPromptSourceReplyDeliveryMode: sessionStableSourceReplyDeliveryMode,
                ...({
                  onSessionMetadataChanges: notifySessionMetadataChanges,
                  onSessionPrepared: notePreparedSession,
                } satisfies InternalReplyResolverOptions),
                onObservedReplyDelivery: markObservedReplyDelivery,
                suppressToolErrorWarnings,
                shouldSuppressToolErrorWarnings,
                typingPolicy: typing.typingPolicy,
                suppressTyping: typing.suppressTyping,
                onPartialReply: wrapProgressCallback(params.replyOptions?.onPartialReply),
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
                onItemEvent,
                commentaryProgressEnabled:
                  deliverStandaloneCommentaryProgress ||
                  canForwardSuppressedSourceItemEvents ||
                  params.replyOptions?.commentaryProgressEnabled,
                reasoningPayloadsEnabled,
                commentaryPayloadsEnabled,
                onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput, {
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                  onVisible: (payload) => {
                    if (hasFailedProgressStatus(payload)) {
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
                  getDispatchReplyOperation()?.recordActivity();
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
                      shouldDeliverFastModeAutoProgressDespiteSourceSuppression();
                    const isForcedToolProgress =
                      shouldDeliverForcedToolProgressDespiteSourceSuppression();
                    const progressCallbackForwarded = shouldForwardToolResultProgressCallback(
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
                    if (sendPolicyDenied) {
                      return;
                    }
                    if (
                      shouldSuppressProgressDelivery() &&
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
                      shouldSuppressLateTextOnlyToolProgress(deliveryPayload) &&
                      !isFastModeAutoProgressPayload(deliveryPayload) &&
                      !isForcedToolProgress
                    ) {
                      return;
                    }
                    if (shouldSuppressMessageToolOnlyTextErrorProgress(deliveryPayload)) {
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
                        !hasExecApprovalPayload(deliveryPayload) &&
                        !hasAskUserPayload(deliveryPayload)
                      ) {
                        return;
                      }
                    }
                    if (deliveryPayload.isError === true) {
                      markVisibleToolErrorProgress();
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
                      markInboundDedupeReplayUnsafe();
                      const delivered = dispatcher.sendToolResult(deliveryPayload);
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
                    await onPlanUpdateFromReplyOptions?.(normalized);
                  }
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  if (payload.phase !== "update" || shouldSuppressDefaultToolProgressMessages()) {
                    return;
                  }
                  await sendPlanUpdate({
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
                    await onApprovalEventFromReplyOptions?.(payload);
                  }
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  if (
                    payload.phase !== "requested" ||
                    shouldSuppressDefaultToolProgressMessages()
                  ) {
                    return;
                  }
                  const label = summarizeApprovalLabel({
                    status: payload.status,
                    command: payload.command,
                    message: payload.message,
                  });
                  if (!label) {
                    return;
                  }
                  await maybeSendWorkingStatus(label);
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
                    await onPatchSummaryFromReplyOptions?.(payload);
                  }
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  if (payload.phase !== "end" || shouldSuppressDefaultToolProgressMessages()) {
                    return;
                  }
                  const label = summarizePatchLabel({
                    summary: payload.summary,
                    title: payload.title,
                  });
                  if (!label) {
                    return;
                  }
                  await maybeSendWorkingStatus(label);
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
                    if (suppressDelivery) {
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
                      if (state.accumulatedBlockText.length > 0) {
                        state.accumulatedBlockText += "\n";
                      }
                      state.accumulatedBlockText += payload.text;
                      if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
                        state.accumulatedBlockTtsText += "\n";
                      }
                      state.accumulatedBlockTtsText += payload.text;
                      state.blockCount++;
                    }
                    const visiblePayload =
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
                    if (!suppressAutomaticSourceDelivery) {
                      await params.replyOptions?.onBlockReplyQueued?.(
                        visiblePayload,
                        queuedContext,
                      );
                    }
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
                      await sendPayloadAsync(
                        normalizedPayload,
                        context?.abortSignal,
                        false,
                        "block",
                      );
                    } else {
                      markInboundDedupeReplayUnsafe();
                      const delivered = dispatcher.sendBlockReply(normalizedPayload);
                      if (delivered) {
                        state.hasPendingDirectBlockReplyDelivery = true;
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
  );
  const sessionMetadataChanges = takeCommandSessionMetadataChanges(ctx);
  notifySessionMetadataChanges(sessionMetadataChanges);
  const finalDispatchAcquisition = await ensureDispatchReplyOperation("dispatch");
  if (finalDispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
  }
  if (finalDispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: finishReplyOperationBusyDispatch({
        recordAgentDispatchCompleted: true,
        ...(state.sessionMetadataChangesForResult
          ? { sessionMetadataChanges: state.sessionMetadataChangesForResult }
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
                  sessionKey: acpDispatchSessionKey,
                  toolsAllow: params.replyOptions?.toolsAllow,
                  images: params.replyOptions?.images,
                  inboundAudio,
                  sessionTtsAuto,
                  ttsChannel: deliveryChannel,
                  suppressUserDelivery: suppressHookUserDelivery,
                  suppressReplyLifecycle: suppressHookReplyLifecycle,
                  sourceReplyDeliveryMode,
                  shouldRouteToOriginating,
                  originatingChannel: routeReplyChannel,
                  originatingTo: routeReplyTo,
                  originatingAccountId: replyContextAccountId,
                  originatingThreadId: routeReplyThreadId,
                  originatingChatType: replyRoute.chatType,
                  shouldSendToolSummaries,
                  sendPolicy,
                  isTailDispatch: true,
                }),
                {
                  cfg,
                  dispatcher: dispatchHookDispatcher,
                  abortSignal: getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                  onReplyStart: params.replyOptions?.onReplyStart,
                  recordProcessed,
                  markIdle,
                },
              ),
            trackDispatchLifecycleWork,
          ),
      );
      if (tailDispatchResult?.handled) {
        recordAgentDispatchCompleted("completed");
        completeDispatchReplyOperation();
        return {
          status: "complete" as const,
          result: attachSourceReplyDeliveryMode({
            queuedFinal: tailDispatchResult.queuedFinal,
            counts: tailDispatchResult.counts,
            ...(state.sessionMetadataChangesForResult
              ? { sessionMetadataChanges: state.sessionMetadataChangesForResult }
              : {}),
          }),
        };
      }
    }
  }
  const nextState = extendPreparedDispatchState(state, { replyResult }, {});
  return { status: "ready" as const, state: nextState };
}

type ExecuteDispatchResult = Awaited<ReturnType<typeof executeDispatch>>;
export type ExecuteDispatchReadyState = Extract<
  ExecuteDispatchResult,
  { status: "ready" }
>["state"];
