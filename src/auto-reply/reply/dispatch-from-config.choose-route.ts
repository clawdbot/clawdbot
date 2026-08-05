import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { createPluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import {
  DispatchReplyOperationAbortedError,
  runWithDispatchAbortSignal,
} from "./dispatch-from-config.abort.js";
import { createReplyDispatchEvent } from "./dispatch-from-config.events.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import {
  captureDeliveredTranscriptMirror,
  getDispatcherFinalOutcomeCounts,
  mirrorDeliveredReplyToTranscript,
  mirrorTranscriptAfterDispatcherSettled,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

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
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    shouldEmitVerboseProgress,
    shouldRouteToOriginating,
    sourceReplyDeliveryMode,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    traceReplyPhase,
    trackDispatchLifecycleWork,
    turnLedger,
  } = state;
  const shouldSuppressProgressDelivery = () =>
    sendPolicyDenied ||
    (suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression());
  const shouldSuppressDefaultToolProgressMessages = () => !shouldEmitVerboseProgress();
  const shouldSendVerboseProgressMessages = () => !shouldSuppressDefaultToolProgressMessages();
  const shouldSendToolSummaries = () => shouldSendVerboseProgressMessages();
  const notifiedSessionMetadataChangeKeys = new Set<string>();
  const routeState: { sessionMetadataChangesForResult?: CommandSessionMetadataChange[] } = {};
  const notifySessionMetadataChanges = (
    changes: CommandSessionMetadataChange[] | undefined,
  ): void => {
    if (!changes?.length) {
      return;
    }
    const freshChanges: CommandSessionMetadataChange[] = [];
    for (const change of changes) {
      const key = JSON.stringify([change.sessionKey, change.agentId ?? null, change.reason]);
      if (notifiedSessionMetadataChangeKeys.has(key)) {
        continue;
      }
      notifiedSessionMetadataChangeKeys.add(key);
      freshChanges.push(change);
    }
    if (freshChanges.length === 0) {
      return;
    }
    routeState.sessionMetadataChangesForResult = [
      ...(routeState.sessionMetadataChangesForResult ?? []),
      ...freshChanges,
    ];
    params.onSessionMetadataChanges?.(freshChanges);
  };
  const shouldDeliverVerboseProgressDespiteSourceSuppression = () =>
    suppressAutomaticSourceDelivery &&
    sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !sendPolicyDenied &&
    shouldEmitVerboseProgress() &&
    shouldSendVerboseProgressMessages();
  const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
    suppressAutomaticSourceDelivery &&
    sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !sendPolicyDenied &&
    params.replyOptions?.forceToolResultProgress === true;
  const shouldDeliverFastModeAutoProgressDespiteSourceSuppression = () =>
    suppressAutomaticSourceDelivery &&
    sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !sendPolicyDenied;
  let finalReplyDeliveryStarted = false;
  const hasExecApprovalPayload = (payload: ReplyPayload) => {
    const execApproval =
      payload.channelData &&
      typeof payload.channelData === "object" &&
      !Array.isArray(payload.channelData)
        ? payload.channelData.execApproval
        : undefined;
    return execApproval && typeof execApproval === "object" && !Array.isArray(execApproval);
  };
  const hasAskUserPayload = (payload: ReplyPayload) => {
    const askUser = payload.channelData?.askUser;
    return askUser && typeof askUser === "object" && !Array.isArray(askUser);
  };
  const readAskUserQuestionId = (payload: ReplyPayload) => {
    const askUser = payload.channelData?.askUser;
    if (!askUser || typeof askUser !== "object" || Array.isArray(askUser)) {
      return undefined;
    }
    const questionId = (askUser as { questionId?: unknown }).questionId;
    return typeof questionId === "string" ? questionId : undefined;
  };
  const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) => {
    if (!finalReplyDeliveryStarted) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload) && !hasAskUserPayload(payload);
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
      sourceReplyDeliveryMode !== "message_tool_only" ||
      state.shouldEmitFullVerboseProgress() ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
  const deliveredBlockContentKeys = new Set<string>();
  const pendingBlockDeliveryOutcomes = new Map<
    string,
    Array<Promise<ReplyDispatchDeliveryOutcome>>
  >();
  const sendTrackedBlockReply = (payload: ReplyPayload): boolean => {
    const contentKey = createBlockReplyContentKey(payload);
    const delivery = turnLedger.sendQueued("block", payload);
    if (!delivery.queued || !delivery.outcome) {
      return delivery.queued;
    }
    const outcomes = pendingBlockDeliveryOutcomes.get(contentKey);
    if (outcomes) {
      outcomes.push(delivery.outcome);
    } else {
      pendingBlockDeliveryOutcomes.set(contentKey, [delivery.outcome]);
    }
    return delivery.queued;
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
    const outcomes = pendingBlockDeliveryOutcomes.get(contentKey);
    if (!outcomes) {
      return false;
    }
    pendingBlockDeliveryOutcomes.delete(contentKey);
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
    payload: ReplyPayload,
    options: { abortSignal?: AbortSignal; deliveryId?: string } = {},
  ): Promise<{
    dedupedAgainstBlock?: boolean;
    queuedFinal: boolean;
    routedFinalCount: number;
    dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
  }> => {
    const abortSignal = options.abortSignal ?? state.getDispatchAbortSignal();
    const throwIfFinalDeliveryAborted = () => {
      if (abortSignal?.aborted) {
        throw new DispatchReplyOperationAbortedError();
      }
    };
    throwIfFinalDeliveryAborted();
    // Trailing commentary must land ahead of the final answer.
    await flushPendingCommentaryProgress();
    throwIfFinalDeliveryAborted();
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const sourceReplySessionBinding = resolvePreparedTranscriptBinding(
      payloadMetadata?.sourceReplyTranscriptMirror?.sessionKey,
    );
    const sourceReplyTranscriptMirror = payloadMetadata?.sourceReplyTranscriptMirror
      ? {
          ...payloadMetadata.sourceReplyTranscriptMirror,
          ...(sourceReplySessionBinding
            ? { expectedSessionId: sourceReplySessionBinding.sessionId }
            : {}),
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
    const ttsPayload =
      payload.isReasoning === true || payload.isCommentary === true
        ? payload
        : await state.maybeApplyTtsWithFinalizationLease({
            payload,
            cfg,
            channel: deliveryChannel,
            kind: "final",
            ttsAuto: sessionTtsAuto,
            agentId: sessionAgentId,
            accountId: replyRoute.accountId,
          });
    throwIfFinalDeliveryAborted();
    let normalizedPayload = await state.normalizeReplyMediaPayload(ttsPayload);
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
    markInboundDedupeReplayUnsafe();
    const finalOutcomeBefore = transcriptMirror
      ? getDispatcherFinalOutcomeCounts(dispatcher)
      : undefined;
    const finalDeliveryCapture = transcriptMirror ? {} : undefined;
    const deliveredTranscriptMirror = transcriptMirror
      ? captureDeliveredTranscriptMirror({
          dispatcher,
          metadata: transcriptMirror,
          deliveryId: options.deliveryId,
          captureToken: finalDeliveryCapture,
        })
      : undefined;
    if (finalDeliveryCapture) {
      setReplyPayloadMetadata(normalizedPayload, { finalDeliveryCapture });
    }
    const { queued: queuedFinal, outcome: dispatcherOutcome } = turnLedger.sendQueued(
      "final",
      normalizedPayload,
    );
    if (queuedFinal && deliveredTranscriptMirror && finalOutcomeBefore) {
      // The common settle owner runs this after successful delivery or
      // cancellation. Keeping reconciliation out of the reply operation lets a
      // newer foreground turn settle without creating an operation/idle cycle.
      registerReplyDispatcherSettledTask(dispatcher, () =>
        mirrorTranscriptAfterDispatcherSettled({
          dispatcher,
          before: finalOutcomeBefore,
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
      if (text && !suppressDelivery) {
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

  if (hookRunner?.hasHooks("reply_dispatch")) {
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
                  sourceReplyDeliveryMode,
                  shouldRouteToOriginating,
                  originatingChannel: routeReplyChannel,
                  originatingTo: routeReplyTo,
                  originatingAccountId: replyContextAccountId,
                  originatingThreadId: routeReplyThreadId,
                  originatingChatType: replyRoute.chatType,
                  shouldSendToolSummaries,
                  sendPolicy: state.sendPolicy,
                }),
                {
                  cfg,
                  dispatcher: state.dispatchHookDispatcher,
                  abortSignal: getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                  onReplyStart: params.replyOptions?.onReplyStart,
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

  const dispatchAcquisition = await state.ensureDispatchReplyOperation("dispatch");
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
    hasExecApprovalPayload,
    hasAskUserPayload,
    readAskUserQuestionId,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    sendTrackedBlockReply,
    recordRoutedBlockReplyDelivery,
    wasReplyDeliveredAsBlock,
    sendFinalPayload,
    routeState,
  });
  return { status: "ready" as const, state: nextState };
}

type ChooseDispatchRouteResult = Awaited<ReturnType<typeof chooseDispatchRoute>>;
export type ChooseDispatchRouteReadyState = Extract<
  ChooseDispatchRouteResult,
  { status: "ready" }
>["state"];
