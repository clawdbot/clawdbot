/** Dispatches isolated cron output to direct delivery, mirrors, and follow-up queues. */
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import { resolveSessionStorePathCore } from "../../config/sessions/inbound.runtime.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  NormalizedOutboundPayload,
  OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import { normalizeCronRunErrorText } from "../service/execution-errors.js";
import type { CronResolvedDeliveryState } from "../types.js";
import { commitCurrentSessionCronCompletion } from "./current-session-completion.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  buildDirectCronTranscriptMirrorPayloads,
  type DirectCronTranscriptMirror,
  formatTargetCronDeliveryFailureAwarenessText,
  projectDeliveredDirectCronPayloadsForMirror,
  queueCronAwarenessSystemEvent,
  queueCronMessageToolDeliveryAwareness,
  resolveCronAwarenessMainSessionKey,
  resolveCronAwarenessText,
  commitDirectCronOutboundRoute,
  resolveDirectCronDeliverySessionKey,
  resolveDirectCronTranscriptMirrorText,
  isSameSessionKey,
  shouldQueueCronAwareness,
} from "./delivery-dispatch-awareness.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
  isCompletedDirectCronDelivery,
  logCronDeliveryError,
  logCronDeliveryErrorDeferred,
  logCronDeliveryWarn,
  maybeApplyTtsToCronPayloads,
  normalizeSilentReplyText,
  prependStaleCronDeliveryNotice,
  resolveCronDeliveryBestEffort,
  resolveDescendantSubagentFollowup,
  resolveStaleCronDeliveryAction,
  retryTransientDirectCronDelivery,
  waitForCompletedDirectCronDelivery,
} from "./delivery-dispatch-policy.js";
import type {
  DispatchCronDeliveryParams,
  DispatchCronDeliveryState,
  SuccessfulCronDeliveryTarget,
} from "./delivery-dispatch-types.js";
import {
  appendCronRunInspectionLink,
  normalizeDirectCronDeliveryPayloads,
} from "./delivery-payload-normalization.js";
import { pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

const deliveryOutboundRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-outbound.runtime.js"),
);
export { queueCronMessageToolDeliveryAwareness, resolveCronDeliveryBestEffort };
/** Dispatches cron run output through verified message-tool or direct delivery paths. */
export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const sourceDeliverySatisfied = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
  const requiresCurrentSessionCompletion = params.job.sessionTarget === "current";
  const verifiedMessageToolDelivery = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  const deliveryState: CronResolvedDeliveryState = {
    status: params.deliveryRequested ? "not-delivered" : "not-requested",
    delivered: false,
    failureNotification: { status: "not-requested" },
  };
  const recordDelivery = (
    status: CronResolvedDeliveryState["status"],
    error?: string,
    deliverySuppressionReason?: NormalizeReplySkipReason,
  ) => {
    deliveryState.status = status;
    deliveryState.delivered =
      status === "delivered" ? true : status === "not-delivered" ? false : undefined;
    deliveryState.error = error;
    deliveryState.deliverySuppressionReason = deliverySuppressionReason;
  };
  if (verifiedMessageToolDelivery) {
    recordDelivery("delivered");
  }
  let deliveryAttempted = verifiedMessageToolDelivery;
  let deferredDeletingSessionMirror: DirectCronTranscriptMirror | undefined;
  const buildDeliveryState = async (result?: RunCronAgentTurnResult) => {
    const completion = resolveAdmittedCronCompletionStatus(
      params.job,
      result?.status === "error" ? "error" : params.undeliveredRunStatus,
      deliveryState.status,
      deliveryState.deliverySuppressionReason,
    );
    // Quiet/best-effort successes retire with their jobs; failed executions retain evidence.
    if (
      deliveryState.status === "delivered" ||
      deliveryState.status === "not-requested" ||
      completion === "succeeded"
    ) {
      await cleanupDirectCronSessionIfNeeded();
    }
    await params.queueSourceSessionMessageToolAwareness?.();
    return {
      ...(result ? { result } : {}),
      deliveryState,
      delivered: deliveryState.delivered,
      deliveryAttempted,
      deliveryError: deliveryState.error,
      deliverySuppressionReason: deliveryState.deliverySuppressionReason,
      summary,
      outputText,
      synthesizedText,
      deliveryPayloads,
    };
  };
  const formatDeliveryTargetError = (error: string) =>
    params.sourceDeliveryOutcome.unverifiedMessageToolDelivery
      ? `${error}; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target`
      : error;
  const failDeliveryTarget = (error: string) =>
    params.withRunSession({
      status: "error",
      error: formatDeliveryTargetError(error),
      errorKind: "delivery-target",
      summary,
      outputText,
      delivered: deliveryState.delivered,
      deliveryAttempted,
      deliveryError: deliveryState.error,
      ...params.telemetry,
    });
  const cleanupDirectCronSessionIfNeeded = async () => {
    const cleanupOutcome = await cleanupCronRunSessionAfterRun({
      job: params.job,
      agentSessionKey: params.agentSessionKey,
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      sessionUpdatedAt: params.sessionUpdatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason: "cron-delete-after-run-fallback",
    });
    const survivingMirror = deferredDeletingSessionMirror;
    deferredDeletingSessionMirror = undefined;
    if (cleanupOutcome !== "not-requested" && cleanupOutcome !== "deleted" && survivingMirror) {
      await appendAdmittedDirectCronDeliveryTranscriptMirror({
        job: params.job,
        mirror: survivingMirror,
        abortSignal: params.abortSignal,
      });
    }
  };
  const finishSilentReplyDelivery = (reason: NormalizeReplySkipReason): RunCronAgentTurnResult => {
    deliveryAttempted = true;
    recordDelivery("not-delivered", undefined, reason);
    return params.withRunSession({
      status: "ok",
      summary,
      outputText,
      delivered: false,
      deliveryAttempted: true,
      deliverySuppressionReason: reason,
      ...params.telemetry,
    });
  };
  const deliverViaDirect = async (
    delivery: SuccessfulCronDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    const {
      buildOutboundSessionContext,
      createOutboundSendDeps,
      durableMessageBatchMayHaveReachedRecipient,
      resolveAgentOutboundIdentity,
      resolveCronChannelReplyTransform,
      sendDurableMessageBatchCore,
    } = await deliveryOutboundRuntimeLoader.load();
    const payloadNormalization = normalizeDirectCronDeliveryPayloads({
      deliveryPayloads,
      outputText,
      summary,
      synthesizedText,
      channelTransform: resolveCronChannelReplyTransform({
        channel: delivery.channel,
        cfg: params.cfgWithAgentDefaults,
        accountId: delivery.accountId,
      }),
    });
    if (payloadNormalization.kind === "suppress") {
      return finishSilentReplyDelivery(payloadNormalization.reason);
    }
    const normalizedPayloads = payloadNormalization.payload;
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery,
    });
    let completedDelivery = false;
    try {
      // Recipient custody is a bounded SQLite receipt, not process-local state.
      completedDelivery = isCompletedDirectCronDelivery(deliveryIdempotencyKey);
    } catch (err) {
      if (!params.deliveryBestEffort) {
        throw err;
      }
      await logCronDeliveryWarn(
        `[cron:${params.job.id}] durable delivery receipt unavailable; continuing best-effort delivery: ${formatErrorMessage(err)}`,
      );
    }
    if (completedDelivery) {
      // Transcript and awareness remain best-effort recipient projections;
      // they must not fabricate a second durable conversation-state owner.
      recordDelivery("delivered");
      deliveryAttempted = true;
      return null;
    }
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    try {
      if (params.isAborted()) {
        return params.withRunSession({
          status: "error",
          error: params.abortReason(),
          deliveryAttempted,
          ...params.telemetry,
        });
      }
      let staleAnnotatedPayloads = normalizedPayloads;
      const staleAction = params.deliveryRequested
        ? resolveStaleCronDeliveryAction({ job: params.job, runStartedAt: params.runStartedAt })
        : ({ kind: "fresh" } as const);
      if (staleAction.kind !== "fresh") {
        await logCronDeliveryWarn(`[cron:${params.job.id}] ${staleAction.logMessage}`);
      }
      if (staleAction.kind === "skip") {
        deliveryAttempted = true;
        recordDelivery("not-delivered", staleAction.deliveryError);
        return params.withRunSession({
          status: "ok",
          summary,
          outputText,
          deliveryAttempted,
          delivered: false,
          deliveryError: staleAction.deliveryError,
          ...params.telemetry,
        });
      }
      if (staleAction.kind === "deliver-annotated") {
        staleAnnotatedPayloads = prependStaleCronDeliveryNotice(
          normalizedPayloads,
          staleAction.notice,
        );
      }
      const payloadsForDelivery = (
        await maybeApplyTtsToCronPayloads({
          cfg: params.cfgWithAgentDefaults,
          payloads: staleAnnotatedPayloads,
          delivery,
          agentId: params.agentId,
          ttsAuto: params.ttsAuto,
        })
      ).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
      if (payloadsForDelivery.length === 0) {
        recordDelivery("not-delivered", "cron delivery payload was empty after TTS");
        return null;
      }
      const linkedPayloadsForDelivery = appendCronRunInspectionLink(
        payloadsForDelivery,
        resolveControlUiSessionUrl(params.cfgWithAgentDefaults, {
          sessionKey: params.runSessionKey,
          fallbackAgentId: params.agentId,
          exactKey: true,
        }),
      );
      deliveryAttempted = true;
      const { sessionKey: deliverySessionKey, route: directCronOutboundRoute } =
        await resolveDirectCronDeliverySessionKey({
          cfg: params.cfgWithAgentDefaults,
          job: params.job,
          agentId: params.agentId,
          agentSessionKey: params.agentSessionKey,
          delivery,
        });
      const deliverySession = buildOutboundSessionContext({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        sessionKey: deliverySessionKey,
      });
      const awarenessMainSessionKey = resolveCronAwarenessMainSessionKey({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
      });
      const mirrorTargetsAwarenessMainSession = isSameSessionKey(
        deliverySessionKey,
        awarenessMainSessionKey,
      );
      const mirrorTargetsDeletingRunSession =
        params.job.deleteAfterRun === true &&
        isCronSessionKey(params.agentSessionKey) &&
        isSameSessionKey(deliverySessionKey, params.agentSessionKey);

      // The batch outcome owns failure state; per-payload errors can belong to
      // a proven-not-sent attempt that succeeds on retry.
      let hadPartialFailure = false;
      let completedByConcurrentDelivery = false;
      let payloadMayHaveReachedRecipientBeforeFailure = false;
      // Once-only early commit: the durable sender fires `onDeliveryResult`
      // after each identified platform result, before later fallible work in
      // the batch. Committing the route there (not only after the batch
      // returns) means a first successful sub-send followed by a later failure
      // still records the route — matching `commitOutboundSessionRoute` in
      // gateway server-methods/send.ts (passed as `onDeliveryResult` there too).
      // A fully failed send never reaches this callback, so the route stays
      // untouched; the post-batch safety nets below remain as a second layer.
      let directCronRouteCommitted = false;
      const commitDirectCronRouteEarly = async () => {
        if (directCronRouteCommitted || !directCronOutboundRoute) {
          return;
        }
        directCronRouteCommitted = true;
        await commitDirectCronOutboundRoute({
          cfg: params.cfgWithAgentDefaults,
          runSessionKey: params.runSessionKey,
          delivery,
          route: directCronOutboundRoute,
        });
      };
      // `onPayload` fires after send hooks render the outbound payload, but before
      // platform send. The mirror only consumes this array after full delivery succeeds.
      const attemptedPayloadsForMirror: NormalizedOutboundPayload[] = [];
      const onError = params.deliveryBestEffort
        ? (err: unknown, _payload: unknown) => {
            logCronDeliveryErrorDeferred(
              `[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
            );
          }
        : undefined;
      const runDelivery = async () => {
        attemptedPayloadsForMirror.length = 0;
        const send = await sendDurableMessageBatchCore({
          cfg: params.cfgWithAgentDefaults,
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
          payloads: linkedPayloadsForDelivery,
          session: deliverySession,
          identity,
          bestEffort: params.deliveryBestEffort,
          durability: params.deliveryBestEffort ? "best_effort" : "required",
          deliveryIntentId: deliveryIdempotencyKey,
          reusePendingDeliveryIntent: true,
          completionRetention: DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
          deps: createOutboundSendDeps(params.deps),
          signal: params.abortSignal,
          onError,
          onPayload: (payload) => {
            attemptedPayloadsForMirror.push(payload);
          },
          onDeliveryResult: () => {
            // Early commit: persist the route as soon as the first platform
            // result confirms a recipient was reached, before later sub-sends
            // in the batch can fail. Returning the promise lets the durable
            // sender await it (as gateway send.ts does with
            // commitOutboundSessionRoute), so the route row lands before any
            // later fallible work in the batch. See commitDirectCronRouteEarly.
            return commitDirectCronRouteEarly();
          },
        });
        payloadMayHaveReachedRecipientBeforeFailure ||=
          durableMessageBatchMayHaveReachedRecipient(send);
        if (
          send.status === "failed" &&
          (await waitForCompletedDirectCronDelivery({
            id: deliveryIdempotencyKey,
            signal: params.abortSignal,
          }))
        ) {
          // Another process committed the same fenced recipient intent.
          completedByConcurrentDelivery = true;
          return [];
        }
        if (send.status === "failed") {
          throw send.error;
        }
        if (send.status === "partial_failed") {
          payloadMayHaveReachedRecipientBeforeFailure = true;
          if (!params.deliveryBestEffort) {
            throw send.error;
          }
          hadPartialFailure = true;
          deliveryState.error ??= formatErrorMessage(send.error);
        }
        if (send.status === "suppressed") {
          // The first suppressed payload can precede an identityless platform send.
          const uncertain = durableMessageBatchMayHaveReachedRecipient(send);
          const reason = uncertain ? "adapter_returned_no_identity" : send.reason;
          recordDelivery(
            uncertain ? "unknown" : "not-delivered",
            `cron delivery ${uncertain ? "outcome is unknown" : "was suppressed"}: ${reason}`,
          );
        }
        return send.status === "sent" || send.status === "partial_failed" ? send.results : [];
      };
      let deliveryResults: OutboundDeliveryResult[];
      try {
        deliveryResults = await retryTransientDirectCronDelivery({
          jobId: params.job.id,
          signal: params.abortSignal,
          run: runDelivery,
          shouldRetryError: () => !payloadMayHaveReachedRecipientBeforeFailure,
        });
      } catch (err) {
        const failureAwarenessText = formatTargetCronDeliveryFailureAwarenessText({
          job: params.job,
          channel: delivery.channel,
          to: delivery.to,
          threadId: stringifyRouteThreadId(delivery.threadId),
          partialDelivered: payloadMayHaveReachedRecipientBeforeFailure,
        });
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey: `${deliveryIdempotencyKey}:failure`,
          queueMainSession: false,
          targetSessionKey: deliverySessionKey,
          text: failureAwarenessText,
          targetText: failureAwarenessText,
        });
        // Even when the batch throws (e.g. a partial_failed batch with
        // best-effort disabled), a payload may already have reached the
        // recipient. Persist the route so later sends can continue the
        // conversation — matching the partial-failure safety net in gateway
        // server-methods/send.ts. A fully failed send (no recipient-reached
        // evidence) leaves the route untouched. commitDirectCronRouteEarly is
        // once-only, so this is a no-op if the early onDeliveryResult commit
        // already ran for a recipient-reached sub-send.
        if (payloadMayHaveReachedRecipientBeforeFailure) {
          await commitDirectCronRouteEarly();
        }
        throw err;
      }
      if (completedByConcurrentDelivery) {
        recordDelivery("delivered");
        // Another process completed the same fenced recipient intent. The
        // local send failed, so its onDeliveryResult never fired and the
        // resolved route was never committed. Persist it now so later
        // conversation sends to this target have a route — matching the
        // post-success invariant (the concurrent completion IS a success).
        // commitDirectCronRouteEarly is once-only, so this is a no-op if the
        // early onDeliveryResult commit already ran for a recipient-reached
        // sub-send before the failure.
        await commitDirectCronRouteEarly();
        return null;
      }
      // Only mark delivered when ALL payloads succeeded (no partial failure).
      // A partial batch is not a durable completion, so we never mint a full
      // receipt for it — but it may still have reached the recipient.
      if (deliveryResults.length > 0) {
        recordDelivery(hadPartialFailure ? "not-delivered" : "delivered", deliveryState.error);
      }
      // Persist the outbound route once any payload is confirmed to have
      // reached the recipient, matching the post-success invariant in
      // message-action-send.ts and the partial-failure safety net in gateway
      // server-methods/send.ts (which commits on `sent` OR `partial_failed`).
      // A fully failed send (no recipient-reached evidence) must not mint a
      // conversation identity or rebind the session route; a partial batch
      // that already delivered must not lose the route later sends need.
      // commitDirectCronRouteEarly is once-only, so this is a no-op if the
      // early onDeliveryResult commit already ran mid-batch.
      if (deliveryState.delivered || payloadMayHaveReachedRecipientBeforeFailure) {
        await commitDirectCronRouteEarly();
      }
      // Partial platform evidence remains unknown; never mint a full receipt.
      const deliveryAwarenessText = resolveCronAwarenessText({
        outputText,
        synthesizedText,
        deliveryPayloads: linkedPayloadsForDelivery,
        outboundPayloads: attemptedPayloadsForMirror,
      });
      const shouldQueueAwarenessForDelivery = shouldQueueCronAwareness({
        job: params.job,
        delivery,
        deliveryBestEffort: params.deliveryBestEffort,
      });
      const targetSessionAwarenessText =
        !params.deliveryBestEffort &&
        (shouldQueueAwarenessForDelivery ||
          !isSameSessionKey(deliverySessionKey, awarenessMainSessionKey))
          ? deliveryAwarenessText
          : undefined;
      // For explicit isolated deliveries that resolve to the main session, the
      // awareness queue is the intentional main-session record on the next turn;
      // adding an immediate assistant mirror would make the cron text appear twice.
      const deliveryWillReachAwarenessMainSession =
        mirrorTargetsAwarenessMainSession && Boolean(targetSessionAwarenessText);
      // Implicit/default isolated delivery must not create main-session awareness.
      const mirrorWouldBypassIsolatedAwarenessPolicy =
        mirrorTargetsAwarenessMainSession &&
        params.job.sessionTarget === "isolated" &&
        delivery.mode !== "explicit";
      if (
        deliveryState.delivered &&
        !requiresCurrentSessionCompletion &&
        !deliveryWillReachAwarenessMainSession &&
        !mirrorWouldBypassIsolatedAwarenessPolicy
      ) {
        const mirrorProjection =
          attemptedPayloadsForMirror.length > 0
            ? projectDeliveredDirectCronPayloadsForMirror(attemptedPayloadsForMirror)
            : projectOutboundPayloadPlanForMirror(
                createOutboundPayloadPlan(
                  buildDirectCronTranscriptMirrorPayloads(linkedPayloadsForDelivery),
                  {
                    cfg: params.cfgWithAgentDefaults,
                    sessionKey: deliverySessionKey,
                    surface: delivery.channel,
                  },
                ),
              );
        const mirrorText = resolveDirectCronTranscriptMirrorText(mirrorProjection);
        const transcriptMirror = {
          sessionKey: deliverySessionKey,
          agentId: params.agentId,
          ...(mirrorTargetsDeletingRunSession
            ? {
                expectedSessionId: params.sessionId,
                expectedLifecycleRevision: params.lifecycleRevision,
              }
            : {}),
          text: mirrorText,
          // Keep cron delivery mirrors text-first: non-audio attachment names
          // are folded into mirrorText so media does not replace delivered text.
          mediaUrls: undefined,
          storePath: resolveSessionStorePathCore(params.cfgWithAgentDefaults.session?.store, {
            // This mirror already carries the admitted run owner. Re-parsing a
            // route alias can reject legacy keys or select a different store.
            agentId: params.agentId,
          }),
          idempotencyKey: deliveryIdempotencyKey,
          // The durable marker is a fallback only when target awareness is absent.
          ...(targetSessionAwarenessText === undefined
            ? { deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND } }
            : {}),
          config: params.cfgWithAgentDefaults,
        };
        if (mirrorTargetsDeletingRunSession) {
          deferredDeletingSessionMirror = transcriptMirror;
        } else {
          await appendAdmittedDirectCronDeliveryTranscriptMirror({
            job: params.job,
            mirror: transcriptMirror,
            abortSignal: params.abortSignal,
          });
        }
      }
      if (deliveryState.delivered && targetSessionAwarenessText) {
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey,
          queueMainSession: shouldQueueAwarenessForDelivery,
          text: targetSessionAwarenessText,
          targetSessionKey: deliverySessionKey,
        });
      }
      return null;
    } catch (err) {
      await logCronDeliveryError(
        `[cron:${params.job.id}] delivery failed (${params.deliveryBestEffort ? "bestEffort" : "required"}): ${formatErrorMessage(err)}`,
      );
      deliveryState.error = normalizeCronRunErrorText(err);
      return null;
    }
  };

  const finalizeTextDelivery = async (
    delivery?: SuccessfulCronDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (
      !synthesizedText &&
      !params.spawnOnlyHandoff &&
      !(requiresCurrentSessionCompletion && params.deliveryPayloadHasStructuredContent)
    ) {
      return null;
    }
    const initialSynthesizedText = synthesizedText?.trim() ?? "";
    const spawnOnlyHandoff = params.spawnOnlyHandoff;
    const { finalReply, activeSubagentRuns, hadDescendants } =
      await resolveDescendantSubagentFollowup({
        sessionKey: params.runSessionKey,
        runStartedAt: params.runStartedAt,
        timeoutMs: params.timeoutMs,
        deliveryBestEffort: params.deliveryBestEffort,
        spawnOnlyHandoff,
        initialSynthesizedText,
      });
    if (finalReply) {
      outputText = finalReply;
      summary = pickSummaryFromOutput(finalReply) ?? summary;
      synthesizedText = finalReply;
      deliveryPayloads = [{ text: finalReply }];
    }
    if (spawnOnlyHandoff && !synthesizedText?.trim()) {
      // An accepted spawn is the turn's only completion; retiring it without
      // child output permanently loses one-shot scheduled work.
      const error = params.isAborted()
        ? params.abortReason()
        : activeSubagentRuns > 0
          ? "cron child-session handoff timed out before producing a final assistant payload"
          : "cron child-session handoff completed without a final assistant payload";
      deliveryAttempted = true;
      return params.withRunSession({
        status: "error",
        error,
        delivered: false,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    if (!params.deliveryBestEffort && activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // update to the main requester. Mark deliveryAttempted so the timer does
      // not fire a redundant enqueueSystemEvent fallback (double-announce bug).
      deliveryAttempted = true;
      recordDelivery("not-delivered", "cron descendants are still active without a final reply");
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    if (
      hadDescendants &&
      synthesizedText?.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      !isSilentReplyText(initialSynthesizedText, SILENT_REPLY_TOKEN)
    ) {
      // Descendants existed but no post-orchestration synthesis arrived AND
      // no descendant fallback reply was available. Suppress stale parent
      // text like "on it, pulling everything together". Mark deliveryAttempted
      // so the timer does not fire a redundant enqueueSystemEvent fallback.
      deliveryAttempted = true;
      recordDelivery("not-delivered", "cron descendants completed without a final reply");
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    const normalizedSynthesizedText = normalizeSilentReplyText(synthesizedText);
    const hasStructuredCurrentSessionCompletion =
      requiresCurrentSessionCompletion && params.deliveryPayloadHasStructuredContent;
    if (
      (normalizedSynthesizedText.text === undefined ||
        normalizedSynthesizedText.strippedTrailingSilentToken) &&
      !hasStructuredCurrentSessionCompletion
    ) {
      return finishSilentReplyDelivery("silent");
    }
    synthesizedText = normalizedSynthesizedText.text;
    if (synthesizedText) {
      outputText = synthesizedText;
    }
    if (params.isAborted()) {
      return params.withRunSession({
        status: "error",
        error: params.abortReason(),
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    if (requiresCurrentSessionCompletion) {
      deliveryAttempted = true;
      const completion = await commitCurrentSessionCronCompletion(params, synthesizedText);
      if (!completion.ok) {
        recordDelivery("not-delivered", completion.reason);
        return failDeliveryTarget(completion.reason);
      }
      params.queueSourceSessionMessageToolAwareness = undefined;
      if (!completion.requiresExternalDelivery) {
        // A deliveryError means the conversation's external route failed to
        // resolve; the committed turn keeps its ok status with the failure
        // recorded, instead of collapsing into a run error.
        recordDelivery(
          completion.deliveryError ? "not-delivered" : "delivered",
          completion.deliveryError,
        );
        return null;
      }
      // The source transcript is committed. External custody remains required
      // before the overall delivery can be reported as successful.
      recordDelivery("not-delivered");
    }
    if (!delivery) {
      return null;
    }
    return await deliverViaDirect(delivery);
  };

  if (params.deliveryRequested && params.skipDelivery && !sourceDeliverySatisfied) {
    return buildDeliveryState(finishSilentReplyDelivery(params.skipDelivery));
  }
  if (
    params.deliveryRequested &&
    !params.skipDelivery &&
    (!sourceDeliverySatisfied || requiresCurrentSessionCompletion)
  ) {
    if (!params.resolvedDelivery.ok) {
      if (requiresCurrentSessionCompletion) {
        const finalizedTextResult = await finalizeTextDelivery();
        return buildDeliveryState(finalizedTextResult ?? undefined);
      }
      if (!params.deliveryBestEffort) {
        const error = params.resolvedDelivery.error.message;
        recordDelivery("not-delivered", formatDeliveryTargetError(error));
        return buildDeliveryState(failDeliveryTarget(error));
      }
      recordDelivery("not-delivered", params.resolvedDelivery.error.message);
      await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return buildDeliveryState(
        params.withRunSession({
          status: "ok",
          summary,
          outputText,
          delivered: deliveryState.delivered,
          deliveryError: deliveryState.error,
          deliveryAttempted,
          ...params.telemetry,
        }),
      );
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // send through the real outbound adapter so delivered=true always reflects
    // an actual channel send instead of internal announce routing.
    const useDirectDelivery =
      !requiresCurrentSessionCompletion &&
      (params.deliveryPayloadHasStructuredContent ||
        (params.resolvedDelivery.threadId != null && !params.spawnOnlyHandoff));
    if (useDirectDelivery) {
      const directResult = await deliverViaDirect(params.resolvedDelivery);
      if (directResult) {
        return buildDeliveryState(directResult);
      }
    } else {
      const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
      if (finalizedTextResult) {
        return buildDeliveryState(finalizedTextResult);
      }
    }
  }

  return buildDeliveryState();
}
