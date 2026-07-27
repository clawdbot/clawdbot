/** Dispatches isolated cron output to direct delivery, mirrors, and follow-up queues. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import { resolveStorePath } from "../../config/sessions/inbound.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  NormalizedOutboundPayload,
  OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
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
  resolveDirectCronDeliverySessionKey,
  resolveDirectCronFallbackSourceIndex,
  resolveDirectCronSummaryFallbackText,
  resolveDirectCronTranscriptMirrorText,
  shouldAttachDirectCronFallbackText,
  isSameSessionKey,
  shouldQueueCronAwareness,
} from "./delivery-dispatch-awareness.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  cleanupDirectCronSession,
  getCompletedDirectCronDelivery,
  isStaleCronDelivery,
  loadDeliverySubagentRegistryRuntime,
  logCronDeliveryError,
  logCronDeliveryErrorDeferred,
  logCronDeliveryWarn,
  maybeApplyTtsToCronPayloads,
  normalizeSilentReplyText,
  rememberCompletedDirectCronDelivery,
  resolveCronDeliveryBestEffort,
  resolveCronDeliveryScheduledAtMs,
  resolveCronDeliveryStartDelayMs,
  retryTransientDirectCronDelivery,
} from "./delivery-dispatch-policy.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import {
  cleanupCronRunSessionAfterRun,
  type CronRunSessionCleanupOutcome,
} from "./session-cleanup.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

type DispatchCronDeliveryParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeSessionDelete?: () => void;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  deliveryRequested: boolean;
  skipHeartbeatDelivery: boolean;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  ttsAuto?: TtsAutoMode;
  summary?: string;
  outputText?: string;
  telemetry?: CronRunTelemetry;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  abortReason: () => string;
  withRunSession: (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ) => RunCronAgentTurnResult;
};

/** Mutable delivery-dispatch accumulator returned to the isolated cron runner. */
type DispatchCronDeliveryState = {
  result?: RunCronAgentTurnResult;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryError?: string;
  cronRunSessionCleanupAttempted: boolean;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
};

const deliveryOutboundRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-outbound.runtime.js"),
);
const subagentFollowupRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-followup.runtime.js"),
);
async function loadDeliveryOutboundRuntime(): Promise<
  typeof import("./delivery-outbound.runtime.js")
> {
  return await deliveryOutboundRuntimeLoader.load();
}

async function loadSubagentFollowupRuntime(): Promise<
  typeof import("./subagent-followup.runtime.js")
> {
  return await subagentFollowupRuntimeLoader.load();
}

export {
  cleanupDirectCronSession,
  queueCronMessageToolDeliveryAwareness,
  resolveCronDeliveryBestEffort,
};
/** Dispatches cron run output through verified message-tool or direct delivery paths. */
export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const sourceDeliverySatisfied = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
  const verifiedMessageToolDelivery = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  let delivered = verifiedMessageToolDelivery;
  let deliveryAttempted = verifiedMessageToolDelivery;
  let deliveryError: string | undefined;
  let directCronSessionCleanupAttempted = false;
  let deferredDeletingSessionMirror: DirectCronTranscriptMirror | undefined;
  const buildDeliveryState = (result?: RunCronAgentTurnResult): DispatchCronDeliveryState => ({
    ...(result ? { result } : {}),
    delivered,
    deliveryAttempted,
    ...(deliveryError ? { deliveryError } : {}),
    cronRunSessionCleanupAttempted: directCronSessionCleanupAttempted,
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
  });
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
      deliveryAttempted,
      ...params.telemetry,
    });
  const cleanupDirectCronSessionIfNeeded = async (): Promise<CronRunSessionCleanupOutcome> => {
    if (directCronSessionCleanupAttempted) {
      return "not-requested";
    }
    const cleanupOutcome = await cleanupCronRunSessionAfterRun({
      job: params.job,
      agentSessionKey: params.agentSessionKey,
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      sessionUpdatedAt: params.sessionUpdatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason: "cron-delete-after-run-fallback",
    });
    if (cleanupOutcome !== "not-requested") {
      directCronSessionCleanupAttempted = true;
    }
    const survivingMirror = deferredDeletingSessionMirror;
    deferredDeletingSessionMirror = undefined;
    if (cleanupOutcome !== "not-requested" && cleanupOutcome !== "deleted" && survivingMirror) {
      await appendAdmittedDirectCronDeliveryTranscriptMirror({
        job: params.job,
        mirror: survivingMirror,
        abortSignal: params.abortSignal,
      });
    }
    return cleanupOutcome;
  };
  const finishSilentReplyDelivery = async (): Promise<RunCronAgentTurnResult> => {
    deliveryAttempted = true;
    await cleanupDirectCronSessionIfNeeded();
    return params.withRunSession({
      status: "ok",
      summary,
      outputText,
      delivered: false,
      deliveryAttempted: true,
      ...params.telemetry,
    });
  };

  const deliverViaDirect = async (
    delivery: SuccessfulDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    const {
      buildOutboundSessionContext,
      createOutboundSendDeps,
      resolveAgentOutboundIdentity,
      sendDurableMessageBatch,
    } = await loadDeliveryOutboundRuntime();
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery,
    });
    try {
      const summaryFallbackText = resolveDirectCronSummaryFallbackText({
        outputText,
        summary,
        synthesizedText,
      });
      const normalizedSummaryFallback = summaryFallbackText
        ? normalizeSilentReplyText(summaryFallbackText)
        : undefined;
      const normalizedSummaryFallbackText =
        normalizedSummaryFallback?.strippedTrailingSilentToken === true
          ? undefined
          : normalizedSummaryFallback?.text;
      const normalizeDirectPayload = (payload: ReplyPayload): ReplyPayload => {
        const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
        return normalized
          ? {
              ...payload,
              text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
            }
          : payload;
      };
      const normalizedDeliveryPayloads = deliveryPayloads
        .map(normalizeDirectPayload)
        .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
      const existingFallbackSourceIndex = resolveDirectCronFallbackSourceIndex(
        normalizedDeliveryPayloads,
        normalizedSummaryFallbackText,
      );
      const needsFallbackSource =
        Boolean(normalizedSummaryFallbackText) &&
        normalizedDeliveryPayloads.some(shouldAttachDirectCronFallbackText) &&
        existingFallbackSourceIndex === undefined;
      const fallbackSourceIndex = needsFallbackSource ? 0 : existingFallbackSourceIndex;
      const directPayloads = needsFallbackSource
        ? [{ text: normalizedSummaryFallbackText }, ...normalizedDeliveryPayloads]
        : normalizedDeliveryPayloads;
      let normalizedPayloads: ReplyPayload[] = [];
      for (const payload of directPayloads) {
        normalizedPayloads.push(
          shouldAttachDirectCronFallbackText(payload) && normalizedSummaryFallbackText
            ? {
                ...payload,
                fallbackText: {
                  text: normalizedSummaryFallbackText,
                  ...(fallbackSourceIndex !== undefined
                    ? { replacesPayloadIndex: fallbackSourceIndex }
                    : {}),
                },
              }
            : payload,
        );
      }
      if (normalizedPayloads.length === 0 && normalizedSummaryFallbackText) {
        normalizedPayloads = [{ text: normalizedSummaryFallbackText }];
      }
      if (normalizedPayloads.length === 0) {
        return await finishSilentReplyDelivery();
      }
      if (params.isAborted()) {
        return params.withRunSession({
          status: "error",
          error: params.abortReason(),
          deliveryAttempted,
          ...params.telemetry,
        });
      }
      if (
        params.deliveryRequested &&
        isStaleCronDelivery({
          job: params.job,
          runStartedAt: params.runStartedAt,
        })
      ) {
        deliveryAttempted = true;
        const nowMs = Date.now();
        const scheduledAtMs = resolveCronDeliveryScheduledAtMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        const startDelayMs = resolveCronDeliveryStartDelayMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        await logCronDeliveryWarn(
          `[cron:${params.job.id}] skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 60_000)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 60_000)}m`,
        );
        return params.withRunSession({
          status: "ok",
          summary,
          outputText,
          deliveryAttempted,
          delivered: false,
          ...params.telemetry,
        });
      }
      const payloadsForDelivery = (
        await maybeApplyTtsToCronPayloads({
          cfg: params.cfgWithAgentDefaults,
          payloads: normalizedPayloads,
          delivery,
          agentId: params.agentId,
          ttsAuto: params.ttsAuto,
        })
      ).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
      if (payloadsForDelivery.length === 0) {
        return await finishSilentReplyDelivery();
      }
      deliveryAttempted = true;
      const cachedResults = getCompletedDirectCronDelivery(deliveryIdempotencyKey);
      if (cachedResults) {
        // Cached entries are only recorded after a successful non-empty delivery.
        delivered = true;
        return null;
      }
      const deliverySessionKey = await resolveDirectCronDeliverySessionKey({
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

      // Track bestEffort partial failures so we can log them and avoid
      // marking the job as delivered when payloads were silently dropped.
      let hadPartialFailure = false;
      let payloadMayHaveReachedRecipientBeforeFailure = false;
      // `onPayload` fires after send hooks render the outbound payload, but before
      // platform send. The mirror only consumes this array after full delivery succeeds.
      const attemptedPayloadsForMirror: NormalizedOutboundPayload[] = [];
      const onError = params.deliveryBestEffort
        ? (err: unknown, _payload: unknown) => {
            hadPartialFailure = true;
            deliveryError ??= formatErrorMessage(err);
            logCronDeliveryErrorDeferred(
              `[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
            );
          }
        : undefined;
      const runDelivery = async () => {
        attemptedPayloadsForMirror.length = 0;
        const send = await sendDurableMessageBatch({
          cfg: params.cfgWithAgentDefaults,
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
          payloads: payloadsForDelivery,
          session: deliverySession,
          identity,
          bestEffort: params.deliveryBestEffort,
          durability: params.deliveryBestEffort ? "best_effort" : "required",
          deps: createOutboundSendDeps(params.deps),
          signal: params.abortSignal,
          onError,
          onPayload: (payload) => {
            attemptedPayloadsForMirror.push(payload);
          },
          // Isolated cron direct delivery uses its own transient retry loop.
          // Keep all attempts out of the write-ahead delivery queue so a
          // late-successful first send cannot leave behind a failed queue
          // entry that replays on the next restart.
          // See: https://github.com/openclaw/openclaw/issues/40545
          skipQueue: true,
        });
        // No durable id is still ambiguous: the adapter was already invoked.
        payloadMayHaveReachedRecipientBeforeFailure ||=
          send.payloadOutcomes?.some(
            (outcome) =>
              outcome.status === "sent" ||
              (outcome.status === "failed" && outcome.sentBeforeError) ||
              (outcome.status === "suppressed" &&
                outcome.reason === "adapter_returned_no_identity"),
          ) ?? false;
        if (send.status === "failed") {
          throw send.error;
        }
        if (send.status === "partial_failed") {
          payloadMayHaveReachedRecipientBeforeFailure = true;
          if (!params.deliveryBestEffort) {
            throw send.error;
          }
          hadPartialFailure = true;
          deliveryError ??= formatErrorMessage(send.error);
        }
        return send.status === "sent" || send.status === "partial_failed" ? send.results : [];
      };
      let deliveryResults: OutboundDeliveryResult[];
      try {
        deliveryResults = options?.retryTransient
          ? await retryTransientDirectCronDelivery({
              jobId: params.job.id,
              signal: params.abortSignal,
              run: runDelivery,
              shouldRetryError: () => !payloadMayHaveReachedRecipientBeforeFailure,
            })
          : await runDelivery();
      } catch (err) {
        const failureAwarenessText = formatTargetCronDeliveryFailureAwarenessText({
          job: params.job,
          channel: delivery.channel,
          to: delivery.to,
          threadId: stringifyRouteThreadId(delivery.threadId),
          error: err,
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
        throw err;
      }
      // Only mark delivered when ALL payloads succeeded (no partial failure).
      delivered = deliveryResults.length > 0 && !hadPartialFailure;
      // Intentionally leave partial success uncached: replay may duplicate the
      // successful subset, but caching it here would permanently drop the
      // failed payloads by converting the replay into delivered=true.
      const deliveryAwarenessText = resolveCronAwarenessText({
        outputText,
        synthesizedText,
        deliveryPayloads: payloadsForDelivery,
        outboundPayloads: attemptedPayloadsForMirror,
      });
      const shouldQueueAwarenessForDelivery = shouldQueueCronAwareness({
        job: params.job,
        delivery,
        deliveryBestEffort: params.deliveryBestEffort,
      });
      // For explicit isolated deliveries that resolve to the main session, the
      // awareness queue is the intentional main-session record on the next turn;
      // adding an immediate assistant mirror would make the cron text appear twice.
      const awarenessText = shouldQueueAwarenessForDelivery ? deliveryAwarenessText : undefined;
      const deliveryWillReachAwarenessMainSession =
        mirrorTargetsAwarenessMainSession &&
        shouldQueueAwarenessForDelivery &&
        Boolean(awarenessText);
      // Implicit/default isolated delivery must not create main-session awareness.
      const mirrorWouldBypassIsolatedAwarenessPolicy =
        mirrorTargetsAwarenessMainSession &&
        params.job.sessionTarget === "isolated" &&
        delivery.mode !== "explicit";
      if (
        delivered &&
        !deliveryWillReachAwarenessMainSession &&
        !mirrorWouldBypassIsolatedAwarenessPolicy
      ) {
        const mirrorProjection =
          attemptedPayloadsForMirror.length > 0
            ? projectDeliveredDirectCronPayloadsForMirror(attemptedPayloadsForMirror)
            : projectOutboundPayloadPlanForMirror(
                createOutboundPayloadPlan(
                  buildDirectCronTranscriptMirrorPayloads(payloadsForDelivery),
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
          storePath: resolveStorePath(params.cfgWithAgentDefaults.session?.store, {
            // This mirror already carries the admitted run owner. Re-parsing a
            // route alias can reject legacy keys or select a different store.
            agentId: params.agentId,
          }),
          idempotencyKey: deliveryIdempotencyKey,
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
      if (
        delivered &&
        !params.deliveryBestEffort &&
        deliveryAwarenessText &&
        (shouldQueueAwarenessForDelivery ||
          !isSameSessionKey(deliverySessionKey, awarenessMainSessionKey))
      ) {
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey,
          queueMainSession: shouldQueueAwarenessForDelivery,
          text: deliveryAwarenessText,
          targetSessionKey: deliverySessionKey,
        });
      }
      if (delivered) {
        rememberCompletedDirectCronDelivery(deliveryIdempotencyKey, deliveryResults);
      }
      return null;
    } catch (err) {
      if (!params.deliveryBestEffort) {
        return params.withRunSession({
          status: "error",
          summary,
          outputText,
          error: String(err),
          deliveryAttempted,
          ...params.telemetry,
        });
      }
      await logCronDeliveryError(
        `[cron:${params.job.id}] delivery failed (bestEffort): ${formatErrorMessage(err)}`,
      );
      deliveryError = formatErrorMessage(err);
      return null;
    }
  };

  const deliverViaDirectAndCleanup = async (
    delivery: SuccessfulDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    try {
      return await deliverViaDirect(delivery, options);
    } finally {
      await cleanupDirectCronSessionIfNeeded();
    }
  };

  const finalizeTextDelivery = async (
    delivery: SuccessfulDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (!synthesizedText) {
      return null;
    }
    const initialSynthesizedText = synthesizedText.trim();
    const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
    const subagentRegistryRuntime = await loadDeliverySubagentRegistryRuntime();
    const subagentFollowupSessionKey = params.runSessionKey;
    let activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
      subagentFollowupSessionKey,
    );
    const shouldCheckCompletedDescendants =
      activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText);
    const needsSubagentFollowupRuntime =
      shouldCheckCompletedDescendants || activeSubagentRuns > 0 || expectedSubagentFollowup;
    const subagentFollowupRuntime = needsSubagentFollowupRuntime
      ? await loadSubagentFollowupRuntime()
      : undefined;
    // Also check for already-completed descendants. If the subagent finished
    // before delivery-dispatch runs, activeSubagentRuns is 0 and
    // expectedSubagentFollowup may be false (e.g. cron said "on it" which
    // doesn't match the narrow hint list). We still need to use the
    // descendant's output instead of the interim cron text.
    const completedDescendantReply = shouldCheckCompletedDescendants
      ? await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        })
      : undefined;
    const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
    if (!params.deliveryBestEffort && (activeSubagentRuns > 0 || expectedSubagentFollowup)) {
      let finalReply = await subagentFollowupRuntime?.waitForDescendantSubagentSummary({
        sessionKey: subagentFollowupSessionKey,
        initialReply: initialSynthesizedText,
        timeoutMs: params.timeoutMs,
        observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
      });
      activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
        subagentFollowupSessionKey,
      );
      if (!finalReply && activeSubagentRuns === 0) {
        finalReply = await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        });
      }
      if (finalReply && activeSubagentRuns === 0) {
        outputText = finalReply;
        summary = pickSummaryFromOutput(finalReply) ?? summary;
        synthesizedText = finalReply;
        deliveryPayloads = [{ text: finalReply }];
      }
    } else if (completedDescendantReply) {
      // Descendants already finished before we got here. Use their output
      // directly instead of the cron agent's interim text.
      outputText = completedDescendantReply;
      summary = pickSummaryFromOutput(completedDescendantReply) ?? summary;
      synthesizedText = completedDescendantReply;
      deliveryPayloads = [{ text: completedDescendantReply }];
    }
    if (!params.deliveryBestEffort && activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // update to the main requester. Mark deliveryAttempted so the timer does
      // not fire a redundant enqueueSystemEvent fallback (double-announce bug).
      deliveryAttempted = true;
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
      synthesizedText.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      !isSilentReplyText(initialSynthesizedText, SILENT_REPLY_TOKEN)
    ) {
      // Descendants existed but no post-orchestration synthesis arrived AND
      // no descendant fallback reply was available. Suppress stale parent
      // text like "on it, pulling everything together". Mark deliveryAttempted
      // so the timer does not fire a redundant enqueueSystemEvent fallback.
      deliveryAttempted = true;
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    const normalizedSynthesizedText = normalizeSilentReplyText(synthesizedText);
    if (
      normalizedSynthesizedText.text === undefined ||
      normalizedSynthesizedText.strippedTrailingSilentToken
    ) {
      return await finishSilentReplyDelivery();
    }
    synthesizedText = normalizedSynthesizedText.text;
    outputText = synthesizedText;
    if (params.isAborted()) {
      return params.withRunSession({
        status: "error",
        error: params.abortReason(),
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    return await deliverViaDirectAndCleanup(delivery, { retryTransient: true });
  };

  if (params.deliveryRequested && !params.skipHeartbeatDelivery && !sourceDeliverySatisfied) {
    if (!params.resolvedDelivery.ok) {
      // The target could not be resolved (e.g. a keyless implicit cron whose
      // inherited shared-bucket target was refused). We never send here, so a
      // deleteAfterRun cron must still retire its session/transcript before
      // returning — otherwise the one-shot session leaks. Safe no-op for
      // non-deleteAfterRun / non-cron sessions (see cleanupDirectCronSession).
      await cleanupDirectCronSessionIfNeeded();
      if (!params.deliveryBestEffort) {
        return buildDeliveryState(failDeliveryTarget(params.resolvedDelivery.error.message));
      }
      delivered = false;
      deliveryError = params.resolvedDelivery.error.message;
      await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return buildDeliveryState(
        params.withRunSession({
          status: "ok",
          summary,
          outputText,
          delivered,
          deliveryError,
          deliveryAttempted,
          ...params.telemetry,
        }),
      );
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // send through the real outbound adapter so delivered=true always reflects
    // an actual channel send instead of internal announce routing.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirectAndCleanup(params.resolvedDelivery);
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
