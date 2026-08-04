import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadAsTtsSupplement,
  type ReplyPayload,
} from "../reply-payload.js";
import { isDispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import type { ExecuteDispatchReadyState } from "./dispatch-from-config.execute.js";
import {
  createFinalDispatchPayloadDedupeKey,
  formatSuppressedReplyPayloadForLog,
  NO_VISIBLE_REPLY_FALLBACK_TEXT,
} from "./dispatch-from-config.payloads.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  capturePendingFinalDeliveryIdentity,
  reconcilePendingFinalDeliveryAfterSettlement,
} from "./dispatch-from-config.pending-final.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

export async function finalizeDispatchAndAudit(state: ExecuteDispatchReadyState) {
  const {
    cfg,
    chatType,
    ctx,
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
    sessionStoreEntry,
    suppressDelivery,
    throwIfDispatchOperationAborted,
    turnLedger,
    waitForPendingDirectBlockReplyDelivery,
  } = state;
  const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
  const pendingFinalDelivery = {
    storePath: sessionStoreEntry.storePath,
    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
  };
  const replyPendingIntentIds = new Set(
    replies
      .map((reply) => getReplyPayloadMetadata(reply)?.pendingFinalDeliveryIntentId)
      .filter((intentId): intentId is string => Boolean(intentId)),
  );
  const pendingFinalDeliveryIdentity = capturePendingFinalDeliveryIdentity({
    ...pendingFinalDelivery,
    intentId: replyPendingIntentIds.size === 1 ? [...replyPendingIntentIds][0] : undefined,
  });
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
  let finalDeliveryFailed = false;
  const finalDeliveries: Array<{
    outcome: Promise<ReplyDispatchDeliveryOutcome>;
    payload: ReplyPayload;
  }> = [];
  let allQueuedFinalsObserved = true;
  // Explicit command turns (native or authorized text-slash like /compact) are
  // user-initiated, so a marked terminal reply for the command bypasses
  // room_event suppression. Ambient marked notices (no CommandTurn) stay
  // suppressed in room_event. sendPolicy: deny still suppresses everything.
  // Uses the same helper as the source-reply visibility policy so the bypass
  // and the policy stay aligned.
  const shouldDeliverDespiteSourceReplySuppression = (reply: ReplyPayload) =>
    state.suppressAutomaticSourceDelivery &&
    !sendPolicyDenied &&
    getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression === true &&
    (ctx.InboundEventKind !== "room_event" || state.explicitCommandTurnCtx);
  const sentFinalPayloadDedupeKeys = new Set<string>();
  for (const [replyIndex, reply] of replies.entries()) {
    throwIfDispatchOperationAborted();
    // Durable reasoning is a channel-owned lane; generic channels keep the
    // historical suppression unless they explicitly opt in.
    if (reply.isReasoning === true && !state.reasoningPayloadsEnabled) {
      continue;
    }
    if (reply.isCommentary === true && !state.commentaryPayloadsEnabled) {
      continue;
    }
    if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
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
      continue;
    }
    const finalPayloadDedupeKey = createFinalDispatchPayloadDedupeKey(reply);
    if (sentFinalPayloadDedupeKeys.has(finalPayloadDedupeKey)) {
      continue;
    }
    sentFinalPayloadDedupeKeys.add(finalPayloadDedupeKey);
    const finalReply = await state.sendFinalPayload(reply, { deliveryId: String(replyIndex) });
    if (finalReply.dedupedAgainstBlock) {
      // The delivering block already settled into the turn ledger.
      continue;
    }
    attemptedFinalDelivery = true;
    queuedFinal = finalReply.queuedFinal || queuedFinal;
    routedFinalCount += finalReply.routedFinalCount;
    if (finalReply.queuedFinal) {
      if (finalReply.dispatcherOutcome) {
        finalDeliveries.push({ outcome: finalReply.dispatcherOutcome, payload: reply });
      } else {
        allQueuedFinalsObserved = false;
      }
    }
    if (!finalReply.queuedFinal && finalReply.routedFinalCount === 0) {
      finalDeliveryFailed = true;
    }
  }

  if (attemptedFinalDelivery && !finalDeliveryFailed) {
    if (queuedFinal && allQueuedFinalsObserved) {
      // Delivery observers run from the queue itself, so direct low-level callers
      // reconcile too; the settle task only makes lifecycle owners await it.
      const reconcilePendingFinal = Promise.all(
        finalDeliveries.map(async (delivery) => ({
          outcome: await delivery.outcome,
          payload: delivery.payload,
        })),
      )
        .then(async (deliveries) => {
          await reconcilePendingFinalDeliveryAfterSettlement({
            ...pendingFinalDelivery,
            deliveries,
            identity: pendingFinalDeliveryIdentity,
            replies,
          });
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
      await clearPendingFinalDeliveryAfterSuccess({
        ...pendingFinalDelivery,
        identity: pendingFinalDeliveryIdentity,
      });
    }
    // Register successful queued cleanup before honoring a late abort. The
    // outer settle owner still runs it from finally (#89115).
    throwIfDispatchOperationAborted();
  }

  if (!suppressDelivery) {
    const ttsMode = resolveConfiguredTtsMode(cfg, {
      agentId: sessionAgentId,
      channelId: deliveryChannel,
      accountId: replyRoute.accountId,
    });
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      state.progressState.blockCount > 0 &&
      state.progressState.accumulatedBlockTtsText.trim()
    ) {
      try {
        await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
        throwIfDispatchOperationAborted();
        const ttsSyntheticReply = await state.maybeApplyTtsWithFinalizationLease({
          payload: { text: state.progressState.accumulatedBlockTtsText },
          cfg,
          channel: deliveryChannel,
          kind: "final",
          ttsAuto: state.sessionTtsAuto,
          agentId: sessionAgentId,
          accountId: replyRoute.accountId,
        });
        throwIfDispatchOperationAborted();
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content.
          // Keep the spoken text only for hooks/archive consumers.
          const ttsOnlyPayload = markReplyPayloadAsTtsSupplement(
            {
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
              spokenText: state.progressState.accumulatedBlockTtsText,
              trustedLocalMedia: true,
            },
            state.progressState.accumulatedBlockTtsText,
            { visibleTextAlreadyDelivered: true },
          );
          const normalizedTtsOnlyPayload = await state.normalizeReplyMediaPayload(ttsOnlyPayload);
          throwIfDispatchOperationAborted();
          const result = await routeReplyToOriginating(normalizedTtsOnlyPayload, {
            abortSignal: getDispatchAbortSignal(),
            kind: "final",
          });
          if (result) {
            queuedFinal = result.ok || queuedFinal;
            if (isRoutedReplyDelivered(result)) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            throwIfDispatchOperationAborted();
            markInboundDedupeReplayUnsafe();
            queuedFinal =
              turnLedger.sendQueued("final", normalizedTtsOnlyPayload).queued || queuedFinal;
          }
        }
      } catch (err) {
        if (isDispatchReplyOperationAbortedError(err)) {
          throw err;
        }
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
  // Observed delivery is plugin-attested visibility, a trust level the transport
  // ledger intentionally does not own. Directedness gates both the fallback and
  // eligibility: only a turn that positively addressed the bot may surface a
  // visible failure notice.
  const replyAcceptedByActiveRun = state.replyOperationRunState.admission?.status === "accepted";
  const noVisibleReplyFallbackAllowed = () =>
    noVisibleReplyFallbackDirected &&
    !suppressDelivery &&
    !sendPolicyDenied &&
    state.sourceReplyDeliveryMode !== "message_tool_only" &&
    !emptyFinalAllowedAsSilent &&
    !deliberateSilentTerminalReply &&
    !pendingContinuation &&
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
      const fallbackPayload: ReplyPayload = { text: NO_VISIBLE_REPLY_FALLBACK_TEXT };
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
  state.commitInboundDedupeIfClaimed();
  state.recordAgentDispatchCompleted("completed");
  state.recordProcessed(
    "completed",
    state.bindingState.pluginFallbackReason
      ? { reason: state.bindingState.pluginFallbackReason }
      : undefined,
  );
  state.markIdle("message_completed");
  state.completeDispatchReplyOperation();
  return {
    status: "complete" as const,
    result: state.attachSourceReplyDeliveryMode({
      queuedFinal,
      counts,
      ...(state.routeState.sessionMetadataChangesForResult
        ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
        : {}),
      ...(getObservedReplyDelivery() ? { observedReplyDelivery: true } : {}),
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
      !pendingContinuation
        ? { noVisibleReplyFallbackEligible: true }
        : {}),
      ...(noVisibleReplyFallbackDelivered ? { noVisibleReplyFallbackDelivered: true } : {}),
      ...(beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}),
    }),
  };
}
