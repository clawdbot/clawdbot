import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadAsTtsSupplement,
  type ReplyPayload,
} from "../reply-payload.js";
import { isDispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import type { executeDispatch } from "./dispatch-from-config.execute.js";
import {
  buildNoVisibleReplyFallbackText,
  createFinalDispatchPayloadDedupeKey,
  formatSuppressedReplyPayloadForLog,
  QUEUE_CAP_REJECTION_TEXT,
  shouldDeliverDespiteSourceReplySuppression,
} from "./dispatch-from-config.payloads.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";

type ExecuteDispatchReadyState = Extract<
  Awaited<ReturnType<typeof executeDispatch>>,
  { status: "ready" }
>["state"];

export const needsTtsFallback = (clean: boolean, visible: string, fallback?: string) =>
  clean && !visible.trim() && Boolean(fallback?.trim());

export async function finalizeDispatchAndAudit(state: ExecuteDispatchReadyState) {
  const {
    cfg,
    chatType,
    ctx,
    deferFinalTtsText,
    deliveryChannel,
    deliberateSilentTerminalReply,
    dispatcher,
    emptyFinalAllowedAsSilent,
    getDispatchAbortSignal,
    getObservedReplyDelivery,
    isRoutedReplyDelivered,
    markInboundDedupeReplayUnsafe,
    noVisibleReplyFallbackDirected,
    pendingContinuation,
    pendingContinuationSettlement,
    replyResult,
    replyRoute,
    routeReplyToOriginating,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    suppressDelivery,
    throwIfDispatchOperationAborted,
    turnLedger,
    waitForPendingDirectBlockReplyDelivery,
  } = state;
  const heartbeat = state.replyOperationRunState.heartbeat;
  const pendingFinalOptions = { preserveActivity: heartbeat !== undefined };
  throwIfDispatchOperationAborted();
  const heartbeatReply = await heartbeat?.prepareReply(replyResult, state.replyOperationRunState);
  throwIfDispatchOperationAborted();
  const replies = heartbeatReply
    ? heartbeatReply.reply
      ? [heartbeatReply.reply]
      : []
    : replyResult
      ? Array.isArray(replyResult)
        ? replyResult
        : [replyResult]
      : [];
  const pendingFinalDeliveryIdentity = replies
    .map((reply) => getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion)
    .find((completion) => completion !== undefined);
  const beforeAgentRunBlocked = replies.some(
    (reply) => getReplyPayloadMetadata(reply)?.beforeAgentRunBlocked === true,
  );

  let queuedFinal = false;
  let routedFinalCount = 0;
  let attemptedFinalDelivery = false;
  let acceptedFinal = false;
  let sessionWriterDeliveryRevoked = false;
  let channelTransformSuppressedFinal = false;
  const finalDeliveries: Array<Awaited<ReturnType<typeof state.sendFinalPayload>>> = [];
  const sentFinalPayloadDedupeKeys = new Set<string>();
  let deferredTtsTextPending = state.progressState.accumulatedBlockTtsText;
  let continuationSettlementAttempted = false;
  let continuationSettlementRegistered = false;
  const settleContinuation = async (statusDelivered: boolean) => {
    if (!pendingContinuationSettlement || continuationSettlementAttempted) {
      return;
    }
    continuationSettlementAttempted = true;
    try {
      await pendingContinuationSettlement.settle(statusDelivered);
    } catch (error) {
      if (!statusDelivered) {
        throw error;
      }
      // A delivered waiting status must not strand its child completion when
      // the batch handoff races a replaced registry row. Release the child
      // to its normal terminal-delivery owner instead.
      logVerbose(
        `dispatch-from-config: continuation batch handoff failed: ${formatErrorMessage(error)}`,
      );
      await pendingContinuationSettlement.settle(false);
    }
  };
  try {
    // Final delivery follows every source-ordered progress callback, including
    // trailing commentary on silent or streaming-delivered turns.
    if (state.preserveProgressCallbackStartOrder) {
      await state.progressState.progressCallbackStartTail;
    }
    await state.flushPendingCommentaryProgress();
    for (const [replyIndex, reply] of replies.entries()) {
      throwIfDispatchOperationAborted();
      // Durable reasoning is a channel-owned lane; generic channels keep the
      // historical suppression unless they explicitly opt in.
      if (reply.isReasoning === true && !state.reasoningPayloadsEnabled) {
        await suppressPendingFinalDelivery(reply, pendingFinalOptions);
        await heartbeatReply?.settle?.("cancelled");
        continue;
      }
      if (reply.isCommentary === true && !state.commentaryPayloadsEnabled) {
        await suppressPendingFinalDelivery(reply, pendingFinalOptions);
        await heartbeatReply?.settle?.("cancelled");
        continue;
      }
      if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply, state)) {
        if (hasOutboundReplyContent(reply, { trimText: true })) {
          logVerbose(
            [
              `dispatch-from-config: final reply suppressed by ${state.deliverySuppressionReason || "source delivery policy"}`,
              `(session=${state.acpDispatchSessionKey ?? sessionKey ?? "unknown"}`,
              `provider=${ctx.Provider ?? "unknown"}`,
              `surface=${ctx.Surface ?? "unknown"}`,
              `chatType=${chatType ?? "unknown"}`,
              `inboundEventKind=${ctx.InboundEventKind ?? "unknown"}`,
              `message=${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"}`,
              `${formatSuppressedReplyPayloadForLog(reply)})`,
            ].join(" "),
          );
        }
        await suppressPendingFinalDelivery(reply, pendingFinalOptions);
        await heartbeatReply?.settle?.("cancelled");
        continue;
      }
      const finalPayloadDedupeKey = createFinalDispatchPayloadDedupeKey(reply);
      if (sentFinalPayloadDedupeKeys.has(finalPayloadDedupeKey)) {
        await suppressPendingFinalDelivery(reply, pendingFinalOptions);
        await heartbeatReply?.settle?.("cancelled");
        continue;
      }
      sentFinalPayloadDedupeKeys.add(finalPayloadDedupeKey);
      const shouldAttachDeferredText = deferFinalTtsText && isReplyPayloadTerminalContent(reply);
      const finalReply = await state.sendFinalPayload(reply, {
        deliveryId: String(replyIndex),
        ...(heartbeat ? { skipTts: true } : {}),
        ...(shouldAttachDeferredText
          ? {
              deferredTtsText: deferredTtsTextPending,
            }
          : {}),
      });
      if (heartbeatReply?.settle) {
        const settle = heartbeatReply.settle;
        const outcome =
          finalReply.dispatcherOutcome ??
          Promise.resolve(
            finalReply.blockDeliveryOutcome ?? finalReply.routedOutcome ?? "cancelled",
          );
        registerReplyDispatcherSettledTask(dispatcher, () => outcome.then(settle));
      }
      if (finalReply.sessionWriterDeliveryRevoked) {
        sessionWriterDeliveryRevoked = true;
        continue;
      }
      if (finalReply.suppressionReason) {
        channelTransformSuppressedFinal ||= finalReply.suppressionReason === "channel_transform";
        continue;
      }
      finalDeliveries.push(finalReply);
      acceptedFinal = true;
      if (shouldAttachDeferredText) {
        deferredTtsTextPending = "";
      }
      if (finalReply.blockDeliveryOutcome) {
        const completion = getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion;
        if (
          completion &&
          finalReply.blockDeliveryOutcome === "failed-deliver" &&
          !finalReply.pendingBlock
        ) {
          // Ambiguous direct delivery has no recorded retry custodian; fence its distinct final.
          await settlePendingFinalDelivery({ kind: "pending-final", ...completion }, "unknown", [
            "prepared",
          ]);
        } else {
          // Explicit block custody covers this prepared duplicate; queued/unknown source survives.
          await suppressPendingFinalDelivery(reply, pendingFinalOptions);
        }
        continue;
      }
      attemptedFinalDelivery = true;
      queuedFinal = finalReply.queuedFinal || queuedFinal;
      routedFinalCount += finalReply.routedFinalCount;
      if (finalReply.pendingBlock) {
        // Final-only media cannot confirm or clear the block's independent pending text.
        continue;
      }
      // Queue admission can still be cancelled or fail. Keep the owner's receipt
      // until this exact final payload settles as delivered.
      const onFinalDeliverySuccess = getReplyPayloadMetadata(reply)?.onFinalDeliverySuccess;
      if (onFinalDeliverySuccess) {
        if (finalReply.dispatcherOutcome) {
          registerReplyDispatcherSettledTask(dispatcher, async () => {
            if ((await finalReply.dispatcherOutcome) === "delivered") {
              onFinalDeliverySuccess();
            }
          });
        } else if (finalReply.routedFinalCount > 0) {
          onFinalDeliverySuccess();
        }
      }
      // Metadata survives usage, threading, and transcript decoration; object identity does not.
      if (pendingContinuationSettlement && getReplyPayloadMetadata(reply)?.continuationStatus) {
        if (finalReply.dispatcherOutcome) {
          registerReplyDispatcherSettledTask(dispatcher, async () => {
            const outcome = await finalReply.dispatcherOutcome;
            // A post-send error can leave visibility unknown. Only an acknowledged
            // status may yield the requester and hold child completion delivery.
            await settleContinuation(outcome === "delivered");
          });
          continuationSettlementRegistered = true;
        } else {
          await settleContinuation(finalReply.routedFinalCount > 0);
        }
      }
    }
  } finally {
    // The batch owns release even when an earlier payload fails or the status
    // is filtered out. An admitted status transfers ownership to queue settlement.
    if (!continuationSettlementRegistered) {
      await settleContinuation(false);
    }
  }
  let channelTransformSuppressed =
    (state.progressState.channelTransformSuppressed || channelTransformSuppressedFinal) &&
    !state.progressState.acceptedReplyPayload &&
    !acceptedFinal;

  if (attemptedFinalDelivery) {
    if (
      queuedFinal &&
      finalDeliveries.every((reply) => !reply.queuedFinal || reply.dispatcherOutcome !== undefined)
    ) {
      // Delivery observers run from the queue itself, so direct low-level callers
      // reconcile too; the settle task only makes lifecycle owners await it.
      const reconcilePendingFinal = Promise.all(
        finalDeliveries.flatMap((reply) =>
          reply.dispatcherOutcome ? [reply.dispatcherOutcome] : [],
        ),
      )
        .then(async () => {
          await clearPendingFinalDeliveryAfterSuccess(
            pendingFinalDeliveryIdentity,
            pendingFinalOptions,
          );
        })
        .catch((error: unknown) => {
          logVerbose(
            `dispatch-from-config: pending final reconciliation failed: ${formatErrorMessage(error)}`,
          );
        });
      registerReplyDispatcherSettledTask(dispatcher, () => reconcilePendingFinal);
    } else {
      // Routed delivery has a transport result already. Custom dispatchers that
      // do not expose the core observer retain the legacy queue-admission behavior.
      await clearPendingFinalDeliveryAfterSuccess(
        pendingFinalDeliveryIdentity,
        pendingFinalOptions,
      );
    }
    // Register successful queued cleanup before honoring a late abort. The
    // outer settle owner still runs it from finally (#89115).
    throwIfDispatchOperationAborted();
  }
  if (!suppressDelivery && !channelTransformSuppressed) {
    const ttsMode = resolveConfiguredTtsMode(cfg, {
      agentId: sessionAgentId,
      channelId: deliveryChannel,
      accountId: replyRoute.accountId,
    });
    // Final payloads in separate lanes must not strand the deferred answer.
    if (
      ttsMode === "final" &&
      state.progressState.blockCount > 0 &&
      deferredTtsTextPending.trim() &&
      (replies.length === 0 || deferFinalTtsText)
    ) {
      try {
        await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
        throwIfDispatchOperationAborted();
        const ttsSyntheticReply = await state.maybeApplyTtsWithFinalizationLease({
          payload: { text: deferredTtsTextPending },
          cfg,
          channel: deliveryChannel,
          kind: "final",
          ttsAuto: state.sessionTtsAuto,
          agentId: sessionAgentId,
          accountId: replyRoute.accountId,
        });
        throwIfDispatchOperationAborted();
        if (ttsSyntheticReply.mediaUrl || (deferFinalTtsText && ttsSyntheticReply.text?.trim())) {
          const ttsOnlyPayload = deferFinalTtsText
            ? ttsSyntheticReply
            : markReplyPayloadAsTtsSupplement(
                {
                  mediaUrl: ttsSyntheticReply.mediaUrl,
                  audioAsVoice: ttsSyntheticReply.audioAsVoice,
                  spokenText: deferredTtsTextPending,
                  trustedLocalMedia: true,
                },
                deferredTtsTextPending,
                { visibleTextAlreadyDelivered: true },
              );
          const finalReply = await state.sendFinalPayload(ttsOnlyPayload, {
            abortSignal: getDispatchAbortSignal(),
            skipTts: true,
          });
          queuedFinal = finalReply.queuedFinal || queuedFinal;
          routedFinalCount += finalReply.routedFinalCount;
        } else if (
          needsTtsFallback(
            Boolean(state.cleanBlockTtsDirectiveText),
            cleanDeferredFinalText(deferredTtsTextPending),
            ttsSyntheticReply.text,
          )
        ) {
          const finalReply = await state.sendFinalPayload(ttsSyntheticReply, {
            abortSignal: getDispatchAbortSignal(),
            skipTts: true,
          });
          queuedFinal = finalReply.queuedFinal || queuedFinal;
          routedFinalCount += finalReply.routedFinalCount;
        }
      } catch (err) {
        if (isDispatchReplyOperationAbortedError(err)) {
          throw err;
        }
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`,
        );
        const deferredVisibleText = cleanDeferredFinalText(deferredTtsTextPending);
        if (deferFinalTtsText && deferredVisibleText.trim()) {
          const finalReply = await state.sendFinalPayload(
            { text: deferredVisibleText },
            { abortSignal: getDispatchAbortSignal(), skipTts: true },
          );
          queuedFinal = finalReply.queuedFinal || queuedFinal;
          routedFinalCount += finalReply.routedFinalCount;
        }
      }
    }
  }

  await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
  // Observed delivery is plugin-attested visibility, a trust level the transport
  // ledger intentionally does not own. Directedness gates both the fallback and
  // eligibility: only a turn that positively addressed the bot may surface a
  // visible failure notice.
  const replyAdmission = state.replyOperationRunState.admission;
  const replyAcceptedByActiveRun = replyAdmission?.status === "accepted";
  const queueCapRejected =
    replyAdmission?.status === "skipped" && replyAdmission.reason === "queue-cap";
  const noVisibleReplyFallbackAllowed = () =>
    !heartbeat &&
    noVisibleReplyFallbackDirected &&
    !suppressDelivery &&
    !sendPolicyDenied &&
    state.sourceReplyDeliveryMode !== "message_tool_only" &&
    !emptyFinalAllowedAsSilent &&
    !deliberateSilentTerminalReply &&
    !pendingContinuation &&
    !sessionWriterDeliveryRevoked &&
    !channelTransformSuppressed &&
    !getObservedReplyDelivery() &&
    !replyAcceptedByActiveRun &&
    turnLedger.canAttemptFallback();
  let queuedSettleResult: Awaited<ReturnType<typeof turnLedger.settleQueued>> = "settled";
  if (noVisibleReplyFallbackAllowed()) {
    // Only a turn that still looks empty pays for settlement: pending admissions
    // must resolve (beforeDeliver cancellation, pre-transport failure) before the
    // silence verdict. Turns with settled visibility or a policy-suppressed
    // fallback skip the wait, so deliveries that legitimately outlive the turn
    // (queued same-session mirroring) cannot deadlock the gate on themselves.
    queuedSettleResult = await turnLedger.settleQueued(getDispatchAbortSignal());
  }
  if (queuedSettleResult === "settled") {
    // Adapter-owned presentation may capture a final after sending hooks. Keep that
    // intentional suppression distinct from invisible, cancelled, or failed delivery.
    channelTransformSuppressed ||=
      noVisibleReplyFallbackAllowed() &&
      finalDeliveries.length > 0 &&
      (
        await Promise.all(
          finalDeliveries.map(
            (reply) =>
              reply.dispatcherOutcome ??
              Promise.resolve(reply.blockDeliveryOutcome ?? reply.routedOutcome),
          ),
        )
      ).every((outcome) => outcome === "channel-transform");
    sessionWriterDeliveryRevoked ||= replies.some(
      (reply) => !state.isSessionWriterDeliveryAuthorized(reply),
    );
  }
  let counts = dispatcher.getQueuedCounts();
  let noVisibleReplyFallbackDelivered = false;
  // The agent-result classifier owns deliberate silence and pending continuation;
  // carry those facts here because filtered reply payloads cannot safely rederive either.
  // An aborted or timed-out settle leaves delivery state unknown; admission
  // then keeps its legacy trust and the turn ends without a fallback.
  if (queuedSettleResult === "settled" && noVisibleReplyFallbackAllowed()) {
    try {
      throwIfDispatchOperationAborted();
      // Missing delivery does not establish a failed agent run. Preserve terminal
      // classification rather than turning this notice into an isError payload.
      const fallbackPayload: ReplyPayload = {
        text: queueCapRejected
          ? QUEUE_CAP_REJECTION_TEXT
          : buildNoVisibleReplyFallbackText(state.getAgentRunId()),
      };
      const result = await routeReplyToOriginating(fallbackPayload, {
        abortSignal: getDispatchAbortSignal(),
        kind: "final",
      });
      if (result) {
        // Hook-suppressed results (ok + suppressed) stay undelivered so the
        // eligibility flag survives for channel-level fallbacks.
        if (isRoutedReplyDelivered(result)) {
          queuedFinal = true;
          noVisibleReplyFallbackDelivered = true;
          routedFinalCount += 1;
        } else if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (no-visible-reply fallback) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        throwIfDispatchOperationAborted();
        markInboundDedupeReplayUnsafe();
        const fallbackSend = turnLedger.sendQueued("final", fallbackPayload);
        if (fallbackSend.queued) {
          // Settlement decides the flag: a beforeDeliver hook can still cancel
          // the admitted fallback, and a cancelled fallback must keep the
          // eligibility flag alive for channel-level recovery. The bounded
          // abort-aware wait keeps a wedged transport from blocking
          // finalization; on abort/timeout (and for untracked dispatchers)
          // admission stays the strongest fact so channels cannot double-send.
          const fallbackSettle = await turnLedger.settleQueued(getDispatchAbortSignal());
          throwIfDispatchOperationAborted();
          if (fallbackSettle !== "settled" || turnLedger.mayHaveDelivered()) {
            queuedFinal = true;
            noVisibleReplyFallbackDelivered = true;
            // Re-snapshot so the delivered fallback is reflected in reported counts,
            // matching the TTS-only path which enqueues before the snapshot.
            counts = dispatcher.getQueuedCounts();
          }
        }
      }
    } catch (err) {
      if (isDispatchReplyOperationAbortedError(err)) {
        throw err;
      }
      logVerbose(
        `dispatch-from-config: no-visible-reply fallback failed: ${formatErrorMessage(err)}`,
      );
    }
  }
  counts.final += routedFinalCount;
  const agentRunTerminalOutcome = state.getAgentRunTerminalOutcome();
  state.commitInboundDedupeIfClaimed();
  const messageInjectionAborted = state.replyOperationRunState.messageInjectionAborted === true;
  const questionFailure =
    replyAdmission?.status === "skipped" &&
    (replyAdmission.reason === "question-response-indeterminate" ||
      replyAdmission.reason === "question-response-refused")
      ? replyAdmission.reason
      : undefined;
  const preRunRejection =
    agentRunTerminalOutcome === "failed" ? undefined : state.replyOperationRunState.preRunRejection;
  const dispatchOutcome =
    agentRunTerminalOutcome === "failed" || questionFailure
      ? "error"
      : queueCapRejected || messageInjectionAborted || preRunRejection
        ? "skipped"
        : "completed";
  const dispatchReason =
    questionFailure ??
    (queueCapRejected
      ? "queue-cap"
      : messageInjectionAborted
        ? "reply_operation_aborted"
        : preRunRejection
          ? preRunRejection
          : replyAdmission?.status === "accepted" && replyAdmission.mode === "steer"
            ? "active_run_injected"
            : channelTransformSuppressed
              ? "channel_transform"
              : state.bindingState.pluginFallbackReason);
  state.recordAgentDispatchCompleted(
    dispatchOutcome,
    dispatchReason ? { reason: dispatchReason } : undefined,
  );
  state.recordProcessed(dispatchOutcome, dispatchReason ? { reason: dispatchReason } : undefined);
  state.markIdle(
    dispatchOutcome === "error"
      ? "message_error"
      : queueCapRejected
        ? "message_queue_cap_rejected"
        : "message_completed",
  );
  state.completeDispatchReplyOperation();
  const result = state.attachSourceReplyDeliveryMode({
    queuedFinal,
    counts,
    ...(state.routeState.sessionMetadataChangesForResult
      ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
      : {}),
    ...(getObservedReplyDelivery() ? { observedReplyDelivery: true } : {}),
    ...(replyAdmission?.status === "accepted" ? { deferredToActiveRun: replyAdmission.mode } : {}),
    // Eligibility keys off settled visible delivery: a suppressed or cancelled
    // final (including the core fallback itself) leaves channel-level recovery
    // eligible, while any settled visible delivery clears it. An aborted or
    // timed-out settle leaves delivery unresolved, and a fallback reported as
    // delivered must not stay recoverable — either could double-send.
    ...(!heartbeat &&
    noVisibleReplyFallbackDirected &&
    queuedSettleResult === "settled" &&
    turnLedger.canAttemptFallback() &&
    !noVisibleReplyFallbackDelivered &&
    !getObservedReplyDelivery() &&
    !replyAcceptedByActiveRun &&
    !emptyFinalAllowedAsSilent &&
    !deliberateSilentTerminalReply &&
    !pendingContinuation &&
    !channelTransformSuppressed
      ? { noVisibleReplyFallbackEligible: true }
      : {}),
    ...(noVisibleReplyFallbackDelivered ? { noVisibleReplyFallbackDelivered: true } : {}),
    ...(deliberateSilentTerminalReply ? { deliberateSilentTerminalReply: true } : {}),
    ...(beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}),
  });
  if (agentRunTerminalOutcome) {
    recordAgentRunTerminalOutcome(result, agentRunTerminalOutcome);
  }
  return {
    status: "complete" as const,
    result,
  };
}
