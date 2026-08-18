import { defaultRuntime } from "../../../runtime.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  logAnnounceGiveUp,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import {
  beginSubagentCleanup,
  retireSupersededCleanupIfNeeded,
  retireSupersededCleanupInBackground,
  runDetachedCleanupAttempt,
  scheduleResumeSubagentRun,
  suspendPendingFinalDelivery,
} from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  clearSubagentPendingDelivery,
  emitCompletionEndedHookIfNeeded,
  formatAnnounceDeliveryError,
  hasPriorRequesterDeliveryMirror,
  loadPendingFinalDeliveryPayload,
  markPendingFinalDelivery,
  maskLifecycleIdentifier,
  recordAnnounceDeliveryResult,
  safeMarkRequiredCompletionDeliveryBlocked,
  safeSetSubagentTaskDeliveryStatus,
} from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

type RunSubagentAnnounceFlow =
  (typeof import("../announce/subagent-announce.js"))["runSubagentAnnounceFlow"];
type SubagentAnnounceFlowOutcome = Awaited<ReturnType<RunSubagentAnnounceFlow>>;

const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
  entry.expectsCompletionMessage === true &&
  entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
  entry.execution.outcome?.status === "ok";

export const finalizeResumedAnnounceGiveUp = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    cleanup?: "delete" | "keep";
    cleanupGeneration?: number;
    retryCount?: number;
    completedAt?: number;
  },
) => {
  const params = context.options;
  const { runId, entry, reason, cleanup, cleanupGeneration, retryCount, completedAt } =
    giveUpParams;
  if (shouldSuspendPendingFinalDelivery(entry)) {
    suspendPendingFinalDelivery(context, {
      runId,
      entry,
      reason,
      error: getDeliveryLastError(entry),
    });
    return;
  }
  const deliveryError = getDeliveryLastError(entry) ?? reason;
  clearSubagentPendingDelivery(entry);
  const failedDelivery = ensureDeliveryState(entry);
  failedDelivery.status = "failed";
  failedDelivery.lastError = deliveryError;
  if (retryCount != null) {
    failedDelivery.attemptCount = retryCount;
    failedDelivery.lastAttemptAt = completedAt ?? Date.now();
  }
  safeSetSubagentTaskDeliveryStatus(params, {
    entry,
    deliveryStatus: "failed",
    deliveryError,
  });
  safeMarkRequiredCompletionDeliveryBlocked(params, {
    entry,
    reason: deliveryError,
  });
  entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  if ((cleanup ?? entry.cleanup) === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
  if (
    cleanupGeneration !== undefined &&
    !context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)
  ) {
    await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    return;
  }
  const completionReason = resolveCleanupCompletionReason(entry);
  logAnnounceGiveUp(entry, reason);
  // Retry-limit / expiry give-up should not leave cleanup stuck behind the
  // best-effort ended hook. Mark the run cleaned first, then fire the hook.
  context.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: cleanup ?? entry.cleanup,
    completedAt: completedAt ?? Date.now(),
  });
  if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
    await emitCompletionEndedHookIfNeeded(
      params,
      entry,
      completionReason,
      () =>
        context.isEndedHookOwnerCurrent(runId, entry) &&
        !shouldSuppressSubagentRecoverySessionEffects(entry),
    );
  }
};

export const retryDeferredCompletedAnnounces = (
  context: SubagentLifecycleAnnounceCleanupContext,
  excludeRunId?: string,
) => {
  const params = context.options;
  const now = Date.now();
  for (const [runId, entry] of params.runs.entries()) {
    if (excludeRunId && runId === excludeRunId) {
      continue;
    }
    if (typeof entry.execution.endedAt !== "number") {
      continue;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      continue;
    }
    if (isDeliverySuspended(entry)) {
      continue;
    }
    if (params.suppressAnnounceForSteerRestart(entry)) {
      continue;
    }
    const endedAgo = now - (entry.execution.endedAt ?? now);
    if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
      const cleanupGeneration = beginSubagentCleanup(context, runId);
      if (cleanupGeneration === undefined) {
        continue;
      }
      runDetachedCleanupAttempt(context, {
        runId,
        entry,
        cleanupGeneration,
        run: async () => {
          await finalizeResumedAnnounceGiveUp(context, {
            runId,
            entry,
            reason: "expiry",
          });
        },
      });
      continue;
    }
    params.resumedRuns.delete(runId);
    params.resumeSubagentRun(runId);
  }
};

const finalizeSubagentCleanup = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  runId: string,
  cleanup: "delete" | "keep",
  announceOutcome: SubagentAnnounceFlowOutcome,
  cleanupGeneration: number,
  options?: {
    skipAnnounce?: boolean;
    skipDeliveryStatus?: boolean;
    skipRequesterDelivery?: boolean;
  },
) => {
  const params = context.options;
  const entry = params.runs.get(runId);
  if (!entry) {
    return;
  }
  if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
    await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    return;
  }
  if (entry.expectsCompletionMessage === false || options?.skipRequesterDelivery) {
    clearSubagentPendingDelivery(entry);
    if (options?.skipRequesterDelivery) {
      ensureDeliveryState(entry).status = "not_required";
      entry.suppressCompletionDelivery = undefined;
    }
    entry.wakeOnDescendantSettle = undefined;
    const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
      return;
    }
    context.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup,
      completedAt: Date.now(),
    });
    if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
      await emitCompletionEndedHookIfNeeded(
        params,
        entry,
        resolveCleanupCompletionReason(entry),
        () =>
          context.isEndedHookOwnerCurrent(runId, entry) &&
          !shouldSuppressSubagentRecoverySessionEffects(entry),
      );
    }
    return;
  }
  if (announceOutcome === "delivered" || announceOutcome === "intentional_non_delivery") {
    const delivery = ensureDeliveryState(entry);
    const shouldCreditDelivery =
      announceOutcome === "delivered" &&
      (!options?.skipAnnounce ||
        delivery.status === "delivered" ||
        typeof delivery.announcedAt === "number");
    if (shouldCreditDelivery) {
      const deliveredAt = delivery.deliveredAt ?? delivery.announcedAt ?? Date.now();
      delivery.status = "delivered";
      delivery.deliveredAt = deliveredAt;
      delivery.announcedAt = delivery.announcedAt ?? deliveredAt;
      if (!options?.skipAnnounce) {
        delivery.announcedAt = deliveredAt;
        params.persist(runId);
      }
    }
    if (announceOutcome === "delivered") {
      clearSubagentPendingDelivery(entry);
    } else {
      // The requester-settle batch owns the real delivery now. Retire the
      // per-child retry obligation without converting the handoff into success.
      delivery.status = "pending";
      delivery.disposition = "intentional_non_delivery";
      delivery.payload = undefined;
      delivery.createdAt = undefined;
      delivery.attemptCount = undefined;
      delivery.nextAttemptAt = undefined;
    }
    const finalDelivery = ensureDeliveryState(entry);
    if (shouldCreditDelivery) {
      finalDelivery.status = "delivered";
      finalDelivery.suspendedAt = undefined;
      finalDelivery.suspendedReason = undefined;
    }
    if (shouldCreditDelivery && !options?.skipDeliveryStatus) {
      safeSetSubagentTaskDeliveryStatus(params, {
        entry,
        deliveryStatus: "delivered",
      });
    } else if (announceOutcome === "intentional_non_delivery" && !options?.skipDeliveryStatus) {
      safeSetSubagentTaskDeliveryStatus(params, {
        entry,
        deliveryStatus: "pending",
      });
    }
    if (announceOutcome === "delivered") {
      finalDelivery.lastError = undefined;
      finalDelivery.lastDropReason = undefined;
    }
    entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    const completionReason = resolveCleanupCompletionReason(entry);
    const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
      return;
    }
    context.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup,
      completedAt: Date.now(),
    });
    // Hook loading is best-effort; durable delivery and cleanup must already
    // be terminal before plugin code can fail or stall.
    if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
      await emitCompletionEndedHookIfNeeded(
        params,
        entry,
        completionReason,
        () =>
          context.isEndedHookOwnerCurrent(runId, entry) &&
          !shouldSuppressSubagentRecoverySessionEffects(entry),
      );
    }
    return;
  }

  if (announceOutcome === "session_queued") {
    // The correlated queue owns transport now. Settlement, not admission,
    // decides delivered versus blocked and re-enters cleanup afterward.
    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist(runId);
    return;
  }

  const now = Date.now();
  const deferredDecision = resolveDeferredCleanupDecision({
    entry,
    now,
    activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
    announceExpiryMs: ANNOUNCE_EXPIRY_MS,
    announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
    resolveAnnounceRetryDelayMs,
  });

  if (deferredDecision.kind === "defer-descendants") {
    ensureDeliveryState(entry).lastAttemptAt = now;
    entry.wakeOnDescendantSettle = true;
    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist(runId);
    scheduleResumeSubagentRun(context, runId, entry, deferredDecision.delayMs);
    return;
  }

  if (deferredDecision.kind === "give-up") {
    await finalizeResumedAnnounceGiveUp(context, {
      runId,
      entry,
      reason: deferredDecision.reason,
      cleanup,
      cleanupGeneration,
      retryCount: deferredDecision.retryCount,
      completedAt: now,
    });
    return;
  }

  markPendingFinalDelivery({
    entry,
    error: "announce deferred or direct delivery failed",
  });
  const delivery = ensureDeliveryState(entry);
  delivery.windowStartedAt ??= entry.execution.endedAt ?? now;
  delivery.deadlineAt ??= delivery.windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
  delivery.nextAttemptAt = now + (deferredDecision.resumeDelayMs ?? 0);
  entry.cleanupHandled = false;
  params.resumedRuns.delete(runId);
  params.persist(runId);
  if (deferredDecision.resumeDelayMs == null) {
    return;
  }
  scheduleResumeSubagentRun(context, runId, entry, deferredDecision.resumeDelayMs);
};

export const startSubagentAnnounceCleanupFlow = (
  context: SubagentLifecycleAnnounceCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
): boolean => {
  const params = context.options;
  if (entry.killReconciliation) {
    // Restores and unrelated cleanup retries must not publish a provisional
    // kill. The sweeper re-enters here after durable reconciliation.
    return false;
  }
  const cleanup = entry.cleanup;
  let suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
  if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
    const cleanupGeneration = beginSubagentCleanup(context, runId);
    if (cleanupGeneration === undefined) {
      return false;
    }
    runDetachedCleanupAttempt(context, {
      runId,
      entry,
      cleanupGeneration,
      run: async () => {
        await finalizeSubagentCleanup(context, runId, cleanup, "delivered", cleanupGeneration, {
          skipAnnounce: true,
        });
      },
    });
    return true;
  }
  const cleanupGeneration = beginSubagentCleanup(context, runId);
  if (cleanupGeneration === undefined) {
    return false;
  }
  const cleanupSessionEntry = suppressSessionEffects
    ? undefined
    : loadSubagentSessionEntry({ childSessionKey: entry.childSessionKey });
  const cleanupSessionIdentity =
    cleanupSessionEntry?.sessionId && cleanupSessionEntry.lifecycleRevision
      ? {
          sessionId: cleanupSessionEntry.sessionId,
          lifecycleRevision: cleanupSessionEntry.lifecycleRevision,
        }
      : undefined;
  const suppressChildSessionEffects = () => {
    suppressSessionEffects = true;
    if (entry.execution.suppressSessionEffects !== true) {
      const previousExecution = entry.execution;
      entry.execution = {
        ...entry.execution,
        suppressSessionEffects: true,
      };
      try {
        params.persistOrThrow(runId);
      } catch (error) {
        entry.execution = previousExecution;
        suppressSessionEffects = false;
        throw error;
      }
    }
  };
  const childSessionEffectsAllowed = () => {
    if (!suppressSessionEffects && shouldSuppressSubagentRecoverySessionEffects(entry)) {
      suppressChildSessionEffects();
    }
    return (
      !suppressSessionEffects && context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)
    );
  };
  const skipRequesterDelivery = entry.suppressCompletionDelivery === true;
  if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
    runDetachedCleanupAttempt(context, {
      runId,
      entry,
      cleanupGeneration,
      run: async () => {
        // This driver is detached. Yield once so synchronous successor
        // registration can invalidate it before sessions.delete is submitted.
        await Promise.resolve();
        if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
          await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
          return;
        }
        if (cleanup === "delete" && childSessionEffectsAllowed()) {
          if (!cleanupSessionIdentity) {
            // Without both lifecycle identities, key-only deletion could remove
            // a successor that reused this child session after cleanup yielded.
            suppressChildSessionEffects();
          } else {
            // This durable boundary prevents a late yield from reviving a run
            // after deletion may already have reached the gateway.
            entry.deleteCleanupDispatchedAt ??= Date.now();
            params.persist(runId);
            const sessionCleanup = await deleteSubagentSessionForCleanup({
              callGateway: params.callGateway,
              childSessionKey: entry.childSessionKey,
              spawnMode: entry.spawnMode,
              expectedSessionId: cleanupSessionIdentity.sessionId,
              expectedLifecycleRevision: cleanupSessionIdentity.lifecycleRevision,
              onError: (error) =>
                params.warn("sessions.delete failed during subagent cleanup", {
                  error: buildSafeLifecycleErrorMeta(error),
                  runId: maskLifecycleIdentifier(runId, "run"),
                  childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
                }),
            });
            if (sessionCleanup === "failed") {
              throw new Error("subagent session cleanup did not complete");
            }
            if (sessionCleanup === "changed") {
              suppressChildSessionEffects();
            }
          }
        }
        if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
          await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
          return;
        }
        await finalizeSubagentCleanup(context, runId, cleanup, "delivered", cleanupGeneration, {
          skipAnnounce: true,
          skipDeliveryStatus: true,
          skipRequesterDelivery,
        });
      },
    });
    return true;
  }
  const pendingPayload = loadPendingFinalDeliveryPayload(entry);
  const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
  let latestDeliveryError = getDeliveryLastError(entry);
  const finalizeAnnounceCleanup = async (announceOutcome: SubagentAnnounceFlowOutcome) => {
    if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
      return;
    }
    const shouldCreditPriorDelivery =
      announceOutcome !== "delivered" && (await hasPriorRequesterDeliveryMirror(params, entry));
    if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
      return;
    }
    if (shouldCreditPriorDelivery) {
      latestDeliveryError = undefined;
    }
    if (announceOutcome !== "delivered" && latestDeliveryError) {
      ensureDeliveryState(entry).lastError = latestDeliveryError;
    }
    await finalizeSubagentCleanup(
      context,
      runId,
      cleanup,
      shouldCreditPriorDelivery ? "delivered" : announceOutcome,
      cleanupGeneration,
    );
  };

  const announceParams: Parameters<RunSubagentAnnounceFlow>[0] = {
    childSessionKey: pendingPayload.childSessionKey,
    childRunId: pendingPayload.childRunId,
    requesterSessionKey: pendingPayload.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: pendingPayload.requesterDisplayKey,
    task: pendingPayload.task,
    timeoutMs: params.subagentAnnounceTimeoutMs,
    cleanup: suppressSessionEffects ? "keep" : cleanup,
    roundOneReply: entry.completion?.resultText ?? undefined,
    terminalReply: pendingPayload.terminalReply,
    fallbackReply: entry.completion?.fallbackResultText ?? undefined,
    waitForCompletion: false,
    startedAt: pendingPayload.startedAt,
    endedAt: pendingPayload.endedAt,
    label: pendingPayload.label,
    outcome: pendingPayload.outcome,
    spawnMode: pendingPayload.spawnMode,
    expectsCompletionMessage: pendingPayload.expectsCompletionMessage,
    wakeOnDescendantSettle: pendingPayload.wakeOnDescendantSettle === true,
    suppressChildSessionEffects: suppressSessionEffects,
    isChildSessionEffectsAllowed: childSessionEffectsAllowed,
    isCompletionDeliveryAllowed: () =>
      context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration),
    isCompletionOwnedByRequesterYield: () =>
      entry.requesterTurnYielded === true ||
      entry.requesterSettleWake?.requesterYieldBatch === true,
    onBeforeDeleteChildSession:
      cleanup === "delete"
        ? () => {
            if (!childSessionEffectsAllowed() || entry.acceptedSteerDispatch) {
              return false;
            }
            // Announce owns delete submission; fence late yields at the
            // exact handoff instead of when cleanup merely starts.
            entry.deleteCleanupDispatchedAt ??= Date.now();
            params.persist(runId);
            return true;
          }
        : undefined,
    onDeliveryResult: (delivery) => {
      if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        retireSupersededCleanupInBackground(context, runId, entry, cleanupGeneration);
        return;
      }
      recordAnnounceDeliveryResult(entry, delivery);
      if (delivery.delivered) {
        const deliveryState = ensureDeliveryState(entry);
        deliveryState.status = "delivered";
        deliveryState.announcedAt = deliveryState.deliveredAt ?? Date.now();
        deliveryState.lastError = undefined;
        deliveryState.suspendedAt = undefined;
        deliveryState.suspendedReason = undefined;
        // Identified platform delivery precedes best-effort transcript
        // mirroring; task ownership must become durable at that same edge.
        params.persist(runId);
        safeSetSubagentTaskDeliveryStatus(params, {
          entry,
          deliveryStatus: "delivered",
        });
        latestDeliveryError = undefined;
        return;
      }
      if (delivery.path === "none" && delivery.disposition !== "intentional_non_delivery") {
        ensureDeliveryState(entry).lastDropReason = "sink_unavailable";
      }
      latestDeliveryError = formatAnnounceDeliveryError(delivery);
      if (ensureDeliveryState(entry).lastError !== latestDeliveryError) {
        ensureDeliveryState(entry).lastError = latestDeliveryError;
        params.persist(runId);
      }
    },
  };
  runDetachedCleanupAttempt(context, {
    runId,
    entry,
    cleanupGeneration,
    run: async () => {
      let announceOutcome: SubagentAnnounceFlowOutcome = "retryable";
      try {
        announceOutcome = await params.runSubagentAnnounceFlow(announceParams);
      } catch (error) {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
      }
      await finalizeAnnounceCleanup(announceOutcome);
    },
  });
  return true;
};
