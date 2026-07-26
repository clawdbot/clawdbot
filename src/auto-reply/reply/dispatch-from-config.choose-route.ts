import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
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
import {
  captureReplyDispatchDeliveryOutcome,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatcher.js";

export async function chooseDispatchRoute(state: PrepareDispatchOperationReadyState) {
  const {
    acpDispatchSessionKey,
    attachSourceReplyDeliveryMode,
    cfg,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliveryChannel,
    dispatchHookDispatcher,
    dispatcher,
    ensureDispatchReplyOperation,
    finishReplyOperationAbortedDispatch,
    finishReplyOperationBusyDispatch,
    getDispatchAbortSignal,
    getPreDispatchAbortSignal,
    hookRunner,
    inboundAudio,
    isRoutedReplyDelivered,
    markIdle,
    markInboundDedupeReplayUnsafe,
    maybeApplyTtsWithFinalizationLease,
    messageIdForHook,
    normalizeReplyMediaPayload,
    normalizedCurrentSurface,
    params,
    recordProcessed,
    replyContextAccountId,
    replyRoute,
    resolvePreparedTranscriptBinding,
    routeReplyChannel,
    routeReplyThreadId,
    routeReplyTo,
    routeReplyToOriginating,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sendPolicy,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    shouldEmitFullVerboseProgress,
    shouldEmitVerboseProgress,
    shouldRouteToOriginating,
    sourceReplyDeliveryMode,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookReplyLifecycle,
    suppressHookUserDelivery,
    traceReplyPhase,
    trackDispatchLifecycleWork,
  } = state;
  const shouldSuppressProgressDelivery = () =>
    sendPolicyDenied ||
    (suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression());
  const shouldSuppressDefaultToolProgressMessages = () => !shouldEmitVerboseProgress();
  const shouldSendVerboseProgressMessages = () => !shouldSuppressDefaultToolProgressMessages();
  const shouldSendToolSummaries = () => shouldSendVerboseProgressMessages();
  const shouldSendToolStartStatuses = false;
  const notifiedSessionMetadataChangeKeys = new Set<string>();
  let sessionMetadataChangesForResult: CommandSessionMetadataChange[] | undefined;
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
    sessionMetadataChangesForResult = [...(sessionMetadataChangesForResult ?? []), ...freshChanges];
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
      dispatcher.sendToolResult(payload);
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
    const updatesBufferedItem =
      pendingCommentaryProgress !== null &&
      pendingCommentaryProgress.itemId !== undefined &&
      pendingCommentaryProgress.itemId === itemId;
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
      shouldEmitFullVerboseProgress() ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
  const sendFinalPayload = async (
    payload: ReplyPayload,
    options: { abortSignal?: AbortSignal; deliveryId?: string } = {},
  ): Promise<{
    queuedFinal: boolean;
    routedFinalCount: number;
    dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
  }> => {
    const abortSignal = options.abortSignal ?? getDispatchAbortSignal();
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
        : await maybeApplyTtsWithFinalizationLease({
            payload,
            cfg,
            channel: deliveryChannel,
            kind: "final",
            ttsAuto: sessionTtsAuto,
            agentId: sessionAgentId,
            accountId: replyRoute.accountId,
          });
    throwIfFinalDeliveryAborted();
    const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
    throwIfFinalDeliveryAborted();
    const result = await routeReplyToOriginating(normalizedPayload, {
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
      normalizeOptionalString(messageIdForHook) ??
      normalizeOptionalString(params.replyOptions?.runId);
    const transcriptMirrorSessionBinding = resolvePreparedTranscriptBinding(
      transcriptMirrorSessionKey,
    );
    const transcriptMirror =
      sourceReplyTranscriptMirror ??
      (normalizedCurrentSurface === "slack" && hasVisibleFinalContent && transcriptMirrorSessionKey
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
    const deliveryOutcome = captureReplyDispatchDeliveryOutcome(normalizedPayload);
    const queuedFinal = dispatcher.sendFinalReply(normalizedPayload);
    const dispatcherOutcome =
      queuedFinal && deliveryOutcome.isTracked() ? deliveryOutcome.promise : undefined;
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
    const beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () =>
      runWithDispatchLifecycleAdmission(
        async () =>
          await runWithDispatchAbortSignal(
            getPreDispatchAbortSignal(),
            () =>
              hookRunner.runBeforeDispatch(
                {
                  content: state.hookContext.content,
                  body: state.hookContext.bodyForAgent ?? state.hookContext.body,
                  channel: state.hookContext.channelId,
                  sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
                  senderId: state.hookContext.senderId,
                  replyToId: state.hookContext.replyToId,
                  replyToIdFull: state.hookContext.replyToIdFull,
                  replyToBody: state.hookContext.replyToBody,
                  replyToSender: state.hookContext.replyToSender,
                  replyToIsQuote: state.hookContext.replyToIsQuote,
                  isGroup: state.hookContext.isGroup,
                  timestamp: state.hookContext.timestamp,
                },
                {
                  channelId: state.hookContext.channelId,
                  accountId: state.hookContext.accountId,
                  conversationId: state.inboundClaimContext.conversationId,
                  sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
                  senderId: state.hookContext.senderId,
                  replyToId: state.hookContext.replyToId,
                  replyToIdFull: state.hookContext.replyToIdFull,
                  replyToBody: state.hookContext.replyToBody,
                  replyToSender: state.hookContext.replyToSender,
                  replyToIsQuote: state.hookContext.replyToIsQuote,
                },
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

  const dispatchAcquisition = await ensureDispatchReplyOperation("dispatch");
  if (dispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
  }
  if (dispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
    };
  }
  const nextState = extendPreparedDispatchState(
    state,
    {
      shouldSuppressDefaultToolProgressMessages,
      shouldSendVerboseProgressMessages,
      shouldSendToolSummaries,
      shouldSendToolStartStatuses,
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
      sendFinalPayload,
    },
    {
      sessionMetadataChangesForResult: {
        get: () => sessionMetadataChangesForResult,
        set: (value: typeof sessionMetadataChangesForResult) => {
          sessionMetadataChangesForResult = value;
        },
      },
    },
  );
  return { status: "ready" as const, state: nextState };
}

type ChooseDispatchRouteResult = Awaited<ReturnType<typeof chooseDispatchRoute>>;
export type ChooseDispatchRouteReadyState = Extract<
  ChooseDispatchRouteResult,
  { status: "ready" }
>["state"];
