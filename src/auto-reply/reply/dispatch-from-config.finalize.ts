import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  markReplyPayloadAsTtsSupplement,
  type ReplyPayload,
} from "../reply-payload.js";
import { isDispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import type { executeDispatch } from "./dispatch-from-config.execute.js";
import {
  createFinalDispatchPayloadDedupeKey,
  formatSuppressedReplyPayloadForLog,
  NO_VISIBLE_REPLY_FALLBACK_TEXT,
  QUEUE_CAP_REJECTION_TEXT,
  shouldDeliverDespiteSourceReplySuppression,
} from "./dispatch-from-config.payloads.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

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
  const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
  const pendingFinalDeliveryIdentity = replies
    .map((reply) => getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion)
    .find((completion) => completion !== undefined);
  // Final delivery is outside the progress wrappers. Wait until every source-ordered callback
  // has at least started so a delayed tool/reasoning transition cannot appear after the final.
  if (state.preserveProgressCallbackStartOrder) {
    await state.progressState.progressCallbackStartTail;
  }
  // Backstop: silent/streaming-delivered turns end without a visible final
  // reply; trailing commentary must still land.
  await state.flushPendingCommentaryProgress();
  const beforeAgentRunBlocked = replies.some(
    (reply) => getReplyPayloadMetadata(reply)?.beforeAgentRunBlocked === true,
  );

  let queuedFinal = false;
  let routedFinalCount = 0;
  let attemptedFinalDelivery = false;
  let acceptedFinal = false;
  let finalDeliveryFailed = false;
  let channelTransformSuppressedFinal = false;
  const finalDeliveries: Promise<ReplyDispatchDeliveryOutcome>[] = [];
  let allQueuedFinalsObserved = true;
  const sentFinalPayloadDedupeKeys = new Set<string>();
  let deferredTtsTextPending = state.progressState.accumulatedBlockTtsText;
  for (const [replyIndex, reply] of replies.entries()) {
    throwIfDispatchOperationAborted();
    // Durable reasoning is a channel-owned lane; generic channels keep the
    // historical suppression unless they explicitly opt in.
    if (reply.isReasoning === true && !state.reasoningPayloadsEnabled) {
      await suppressPendingFinalDelivery(reply);
      continue;
    }
    if (reply.isCommentary === true && !state.commentaryPayloadsEnabled) {
      await suppressPendingFinalDelivery(reply);
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
      await suppressPendingFinalDelivery(reply);
      continue;
    }
    const finalPayloadDedupeKey = createFinalDispatchPayloadDedupeKey(reply);
    if (sentFinalPayloadDedupeKeys.has(finalPayloadDedupeKey)) {
      await suppressPendingFinalDelivery(reply);
      continue;
    }
    sentFinalPayloadDedupeKeys.add(finalPayloadDedupeKey);
    const shouldAttachDeferredText =
      deferFinalTtsText &&
      reply.isReasoning !== true &&
      reply.isCommentary !== true &&
      !isReplyPayloadStatusNotice(reply);
    const finalReply = await state.sendFinalPayload(reply, {
      deliveryId: String(replyIndex),
      ...(shouldAttachDeferredText
        ? {
            deferredTtsText: deferredTtsTextPending,
          }
        : {}),
    });
    if (finalReply.suppressionReason) {
      channelTransformSuppressedFinal ||= finalReply.suppressionReason === "channel_transform";
      continue;
    }
    acceptedFinal = true;
    if (shouldAttachDeferredText) {
      deferredTtsTextPending = "";
    }
    if (finalReply.dedupedAgainstBlock) {
      // The delivering block already settled into the turn ledger.
      await suppressPendingFinalDelivery(reply);
      continue;
    }
    attemptedFinalDelivery = true;
    queuedFinal = finalReply.queuedFinal || queuedFinal;
    routedFinalCount += finalReply.routedFinalCount;
    if (finalReply.queuedFinal) {
      if (finalReply.dispatcherOutcome) {
        finalDeliveries.push(finalReply.dispatcherOutcome);
      } else {
        allQueuedFinalsObserved = false;
      }
    }
    if (!finalReply.queuedFinal && finalReply.routedFinalCount === 0) {
      finalDeliveryFailed = true;
    }
  }
  const channelTransformSuppressed =
    (state.progressState.channelTransformSuppressed || channelTransformSuppressedFinal) &&
    !state.progressState.acceptedReplyPayload &&
    !acceptedFinal;

  if (attemptedFinalDelivery && !finalDeliveryFailed) {
    if (queuedFinal && allQueuedFinalsObserved) {
      // Delivery observers run from the queue itself, so direct low-level callers
      // reconcile too; the settle task only makes lifecycle owners await it.
      const reconcilePendingFinal = Promise.all(finalDeliveries)
        .then(async () => {
          await clearPendingFinalDeliveryAfterSuccess(pendingFinalDeliveryIdentity);
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
      await clearPendingFinalDeliveryAfterSuccess(pendingFinalDeliveryIdentity);
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
    noVisibleReplyFallbackDirected &&
    !suppressDelivery &&
    !sendPolicyDenied &&
    state.sourceReplyDeliveryMode !== "message_tool_only" &&
    !emptyFinalAllowedAsSilent &&
    !deliberateSilentTerminalReply &&
    !pendingContinuation &&
    !channelTransformSuppressed &&
    !getObservedReplyDelivery() &&
    !replyAcceptedByActiveRun &&
    !turnLedger.hasVisibleDelivery() &&
    !turnLedger.hasForeignQueuedAdmissions();
  let queuedSettleResult: Awaited<ReturnType<typeof turnLedger.settleQueued>> = "settled";
  if (noVisibleReplyFallbackAllowed()) {
    // Only a turn that still looks empty pays for settlement: pending admissions
    // must resolve (beforeDeliver cancellation, pre-transport failure) before the
    // silence verdict. Turns with settled visibility or a policy-suppressed
    // fallback skip the wait, so deliveries that legitimately outlive the turn
    // (queued same-session mirroring) cannot deadlock the gate on themselves.
    queuedSettleResult = await turnLedger.settleQueued(getDispatchAbortSignal());
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
      const fallbackPayload: ReplyPayload = {
        text: queueCapRejected ? QUEUE_CAP_REJECTION_TEXT : NO_VISIBLE_REPLY_FALLBACK_TEXT,
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
          if (fallbackSettle !== "settled" || turnLedger.hasVisibleDelivery()) {
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
  const dispatchOutcome = queueCapRejected ? "skipped" : "completed";
  const dispatchReason = queueCapRejected
    ? "queue-cap"
    : channelTransformSuppressed
      ? "channel_transform"
      : state.bindingState.pluginFallbackReason;
  state.recordAgentDispatchCompleted(
    dispatchOutcome,
    dispatchReason ? { reason: dispatchReason } : undefined,
  );
  state.recordProcessed(dispatchOutcome, dispatchReason ? { reason: dispatchReason } : undefined);
  state.markIdle(queueCapRejected ? "message_queue_cap_rejected" : "message_completed");
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
    ...(noVisibleReplyFallbackDirected &&
    queuedSettleResult === "settled" &&
    !turnLedger.hasVisibleDelivery() &&
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
