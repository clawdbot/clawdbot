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
} from "./dispatch-from-config.payloads.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  capturePendingFinalDeliveryIdentity,
  reconcilePendingFinalDeliveryAfterSettlement,
} from "./dispatch-from-config.pending-final.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

export async function finalizeDispatchAndAudit(state: ExecuteDispatchReadyState) {
  const {
    acpDispatchSessionKey,
    attachSourceReplyDeliveryMode,
    cfg,
    chatType,
    commentaryPayloadsEnabled,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliveryChannel,
    deliverySuppressionReason,
    dispatcher,
    emptyFinalAllowedAsSilent,
    explicitCommandTurnCtx,
    flushPendingCommentaryProgress,
    getDispatchAbortSignal,
    getObservedReplyDelivery,
    isRoutedReplyDelivered,
    markIdle,
    markInboundDedupeReplayUnsafe,
    maybeApplyTtsWithFinalizationLease,
    normalizeReplyMediaPayload,
    preserveProgressCallbackStartOrder,
    reasoningPayloadsEnabled,
    recordAgentDispatchCompleted,
    recordProcessed,
    replyResult,
    replyRoute,
    routeReplyToOriginating,
    sendFinalPayload,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    throwIfDispatchOperationAborted,
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
  if (preserveProgressCallbackStartOrder) {
    await state.progressCallbackStartTail;
  }
  // Backstop: silent/streaming-delivered turns end without a visible final
  // reply; trailing commentary must still land.
  await flushPendingCommentaryProgress();
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
    suppressAutomaticSourceDelivery &&
    !sendPolicyDenied &&
    getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression === true &&
    (ctx.InboundEventKind !== "room_event" || explicitCommandTurnCtx);
  const sentFinalPayloadDedupeKeys = new Set<string>();
  for (const [replyIndex, reply] of replies.entries()) {
    throwIfDispatchOperationAborted();
    // Durable reasoning is a channel-owned lane; generic channels keep the
    // historical suppression unless they explicitly opt in.
    if (reply.isReasoning === true && !reasoningPayloadsEnabled) {
      continue;
    }
    if (reply.isCommentary === true && !commentaryPayloadsEnabled) {
      continue;
    }
    if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
      if (hasOutboundReplyContent(reply, { trimText: true })) {
        logVerbose(
          [
            `dispatch-from-config: final reply suppressed by ${deliverySuppressionReason || "source delivery policy"}`,
            `(session=${acpDispatchSessionKey ?? sessionKey ?? "unknown"}`,
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
    attemptedFinalDelivery = true;
    const finalReply = await sendFinalPayload(reply, { deliveryId: String(replyIndex) });
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
      state.blockCount > 0 &&
      state.accumulatedBlockTtsText.trim()
    ) {
      try {
        await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
        throwIfDispatchOperationAborted();
        const ttsSyntheticReply = await maybeApplyTtsWithFinalizationLease({
          payload: { text: state.accumulatedBlockTtsText },
          cfg,
          channel: deliveryChannel,
          kind: "final",
          ttsAuto: sessionTtsAuto,
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
              spokenText: state.accumulatedBlockTtsText,
              trustedLocalMedia: true,
            },
            state.accumulatedBlockTtsText,
            { visibleTextAlreadyDelivered: true },
          );
          const normalizedTtsOnlyPayload = await normalizeReplyMediaPayload(ttsOnlyPayload);
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
            const didQueue = dispatcher.sendFinalReply(normalizedTtsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
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
  const counts = dispatcher.getQueuedCounts();
  counts.final += routedFinalCount;
  commitInboundDedupeIfClaimed();
  recordAgentDispatchCompleted("completed");
  recordProcessed(
    "completed",
    state.pluginFallbackReason ? { reason: state.pluginFallbackReason } : undefined,
  );
  markIdle("message_completed");
  completeDispatchReplyOperation();
  return {
    status: "complete" as const,
    result: attachSourceReplyDeliveryMode({
      queuedFinal,
      counts,
      ...(state.sessionMetadataChangesForResult
        ? { sessionMetadataChanges: state.sessionMetadataChangesForResult }
        : {}),
      ...(getObservedReplyDelivery() ? { observedReplyDelivery: true } : {}),
      ...(!queuedFinal && !getObservedReplyDelivery() && !emptyFinalAllowedAsSilent
        ? { noVisibleReplyFallbackEligible: true }
        : {}),
      ...(beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}),
    }),
  };
}
