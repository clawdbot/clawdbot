import { defaultRuntime } from "../runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
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
import { createSubagentRegistryLifecycleBookkeeping } from "./subagent-registry-lifecycle-bookkeeping.js";
import type { createSubagentRegistryLifecycleCleanupBase } from "./subagent-registry-lifecycle-cleanup-base.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { createSubagentRegistryLifecycleDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { createSubagentRegistryLifecycleRequesterWake } from "./subagent-registry-lifecycle-requester-wake.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

export function createSubagentRegistryLifecycleCleanup(
  params: SubagentRegistryLifecycleParams,
  state: SubagentRegistryLifecycleState,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
  deliveryHelpers: ReturnType<typeof createSubagentRegistryLifecycleDelivery>,
  requesterWake: ReturnType<typeof createSubagentRegistryLifecycleRequesterWake>,
  cleanupBase: ReturnType<typeof createSubagentRegistryLifecycleCleanupBase>,
) {
  const { cleanupGenerations } = state;
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey } = common;
  const {
    clearPendingFinalDelivery,
    emitCompletionEndedHookIfNeeded,
    formatAnnounceDeliveryError,
    hasPriorRequesterDeliveryMirror,
    loadPendingFinalDeliveryPayload,
    markPendingFinalDelivery,
    recordAnnounceDeliveryResult,
    safeMarkRequiredCompletionDeliveryBlocked,
    safeSetSubagentTaskDeliveryStatus,
  } = deliveryHelpers;
  const {
    beginSubagentCleanup,
    isCleanupAttemptCurrent,
    isEndedHookOwnerCurrent,
    retireRunModeBundleMcpRuntime,
    retireSupersededCleanupIfNeeded,
    retireSupersededCleanupInBackground,
    runDetachedCleanupAttempt,
    scheduleResumeSubagentRun,
    suspendPendingFinalDelivery,
  } = cleanupBase;

  const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
    entry.expectsCompletionMessage === true &&
    entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
    entry.execution.outcome?.status === "ok";

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
  }) => {
    if (shouldSuspendPendingFinalDelivery(giveUpParams.entry)) {
      suspendPendingFinalDelivery({
        runId: giveUpParams.runId,
        entry: giveUpParams.entry,
        reason: giveUpParams.reason,
        error: getDeliveryLastError(giveUpParams.entry),
      });
      return;
    }
    const deliveryError = getDeliveryLastError(giveUpParams.entry) ?? giveUpParams.reason;
    clearPendingFinalDelivery(giveUpParams.entry);
    const failedDelivery = ensureDeliveryState(giveUpParams.entry);
    failedDelivery.status = "failed";
    failedDelivery.lastError = deliveryError;
    safeSetSubagentTaskDeliveryStatus({
      entry: giveUpParams.entry,
      deliveryStatus: "failed",
      deliveryError,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: giveUpParams.entry,
      reason: deliveryError,
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(giveUpParams.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    // Retry-limit / expiry give-up should not leave cleanup stuck behind the
    // best-effort ended hook. Mark the run cleaned first, then fire the hook.
    completeCleanupBookkeeping({
      runId: giveUpParams.runId,
      entry: giveUpParams.entry,
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
    });
    if (!shouldSuppressSubagentRecoverySessionEffects(giveUpParams.entry)) {
      await emitCompletionEndedHookIfNeeded(
        giveUpParams.entry,
        completionReason,
        () =>
          isEndedHookOwnerCurrent(giveUpParams.runId, giveUpParams.entry) &&
          !shouldSuppressSubagentRecoverySessionEffects(giveUpParams.entry),
      );
    }
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
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
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        runDetachedCleanupAttempt({
          runId,
          entry,
          cleanupGeneration: cleanupGenerations.get(entry)!,
          run: async () => {
            await finalizeResumedAnnounceGiveUp({
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

  const { completeCleanupBookkeeping } = createSubagentRegistryLifecycleBookkeeping(
    params,
    common,
    requesterWake,
    retryDeferredCompletedAnnounces,
  );

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
    cleanupGeneration: number,
    options?: {
      skipAnnounce?: boolean;
      skipDeliveryStatus?: boolean;
      skipRequesterDelivery?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
      await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
      return;
    }
    if (entry.expectsCompletionMessage === false || options?.skipRequesterDelivery) {
      clearPendingFinalDelivery(entry);
      if (options?.skipRequesterDelivery) {
        ensureDeliveryState(entry).status = "not_required";
        entry.suppressCompletionDelivery = undefined;
      }
      entry.wakeOnDescendantSettle = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
        await emitCompletionEndedHookIfNeeded(
          entry,
          resolveCleanupCompletionReason(entry),
          () =>
            isEndedHookOwnerCurrent(runId, entry) &&
            !shouldSuppressSubagentRecoverySessionEffects(entry),
        );
      }
      return;
    }
    if (didAnnounce) {
      const delivery = ensureDeliveryState(entry);
      const shouldCreditDelivery =
        !options?.skipAnnounce ||
        delivery.status === "delivered" ||
        typeof delivery.announcedAt === "number";
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
      clearPendingFinalDelivery(entry);
      const finalDelivery = ensureDeliveryState(entry);
      if (shouldCreditDelivery) {
        finalDelivery.status = "delivered";
        finalDelivery.suspendedAt = undefined;
        finalDelivery.suspendedReason = undefined;
      }
      if (shouldCreditDelivery && !options?.skipDeliveryStatus) {
        safeSetSubagentTaskDeliveryStatus({
          entry,
          deliveryStatus: "delivered",
        });
      }
      finalDelivery.lastError = undefined;
      finalDelivery.lastDropReason = undefined;
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      // Hook loading is best-effort; durable delivery and cleanup must already
      // be terminal before plugin code can fail or stall.
      if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
        await emitCompletionEndedHookIfNeeded(
          entry,
          completionReason,
          () =>
            isEndedHookOwnerCurrent(runId, entry) &&
            !shouldSuppressSubagentRecoverySessionEffects(entry),
        );
      }
      return;
    }

    if (entry.delivery?.disposition === "session_queued") {
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
      scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
      return;
    }

    if (deferredDecision.kind === "give-up") {
      if (shouldSuspendPendingFinalDelivery(entry)) {
        suspendPendingFinalDelivery({
          runId,
          entry,
          reason: deferredDecision.reason,
          error: getDeliveryLastError(entry),
        });
        return;
      }
      const deliveryError = getDeliveryLastError(entry) ?? deferredDecision.reason;
      clearPendingFinalDelivery(entry);
      const failedDelivery = ensureDeliveryState(entry);
      failedDelivery.status = "failed";
      failedDelivery.lastError = deliveryError;
      if (deferredDecision.retryCount != null) {
        failedDelivery.attemptCount = deferredDecision.retryCount;
        failedDelivery.lastAttemptAt = now;
      }
      safeSetSubagentTaskDeliveryStatus({
        entry,
        deliveryStatus: "failed",
        deliveryError,
      });
      safeMarkRequiredCompletionDeliveryBlocked({
        entry,
        reason: deliveryError,
      });
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      // Giving up on announce delivery is terminal for cleanup even if the
      // best-effort hook is still resolving.
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: now,
      });
      if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
        await emitCompletionEndedHookIfNeeded(
          entry,
          completionReason,
          () =>
            isEndedHookOwnerCurrent(runId, entry) &&
            !shouldSuppressSubagentRecoverySessionEffects(entry),
        );
      }
      return;
    }

    markPendingFinalDelivery({
      entry,
      error: didAnnounce ? undefined : "announce deferred or direct delivery failed",
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
    scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (entry.killReconciliation) {
      // Restores and unrelated cleanup retries must not publish a provisional
      // kill. The sweeper re-enters here after durable reconciliation.
      return false;
    }
    const cleanup = entry.cleanup;
    let suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
    if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      const cleanupGeneration = cleanupGenerations.get(entry)!;
      runDetachedCleanupAttempt({
        runId,
        entry,
        cleanupGeneration,
        run: async () => {
          await finalizeSubagentCleanup(runId, cleanup, true, cleanupGeneration, {
            skipAnnounce: true,
          });
        },
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    const cleanupGeneration = cleanupGenerations.get(entry)!;
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
      return !suppressSessionEffects && isCleanupAttemptCurrent(runId, entry, cleanupGeneration);
    };
    const skipRequesterDelivery = entry.suppressCompletionDelivery === true;
    if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
      runDetachedCleanupAttempt({
        runId,
        entry,
        cleanupGeneration,
        run: async () => {
          // This driver is detached. Yield once so synchronous successor
          // registration can invalidate it before sessions.delete is submitted.
          await Promise.resolve();
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
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
                    runId: maskRunId(runId),
                    childSessionKey: maskSessionKey(entry.childSessionKey),
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
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
            return;
          }
          await finalizeSubagentCleanup(runId, cleanup, true, cleanupGeneration, {
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
    const finalizeAnnounceCleanup = async (didAnnounce: boolean) => {
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      const shouldCreditPriorDelivery =
        !didAnnounce && (await hasPriorRequesterDeliveryMirror(entry));
      if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
        await retireSupersededCleanupIfNeeded(runId, entry, cleanupGeneration);
        return;
      }
      if (shouldCreditPriorDelivery) {
        latestDeliveryError = undefined;
      }
      if (!didAnnounce && latestDeliveryError) {
        ensureDeliveryState(entry).lastError = latestDeliveryError;
      }
      await finalizeSubagentCleanup(
        runId,
        cleanup,
        didAnnounce || shouldCreditPriorDelivery,
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
      isCompletionDeliveryAllowed: () => isCleanupAttemptCurrent(runId, entry, cleanupGeneration),
      isCompletionOwnedByRequesterYield: () =>
        entry.requesterTurnYielded === true ||
        entry.requesterSettleWake?.requesterYieldBatch === true,
      onBeforeDeleteChildSession:
        cleanup === "delete"
          ? () => {
              if (!childSessionEffectsAllowed()) {
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
        if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
          retireSupersededCleanupInBackground(runId, entry, cleanupGeneration);
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
          safeSetSubagentTaskDeliveryStatus({ entry, deliveryStatus: "delivered" });
          latestDeliveryError = undefined;
          return;
        }
        if (delivery.path === "none") {
          ensureDeliveryState(entry).lastDropReason = "sink_unavailable";
        }
        latestDeliveryError = formatAnnounceDeliveryError(delivery);
        if (ensureDeliveryState(entry).lastError !== latestDeliveryError) {
          ensureDeliveryState(entry).lastError = latestDeliveryError;
          params.persist(runId);
        }
      },
    };
    runDetachedCleanupAttempt({
      runId,
      entry,
      cleanupGeneration,
      run: async () => {
        let didAnnounce = false;
        try {
          didAnnounce = await params.runSubagentAnnounceFlow(announceParams);
        } catch (error) {
          defaultRuntime.log(
            `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
          );
        }
        await finalizeAnnounceCleanup(didAnnounce);
      },
    });
    return true;
  };

  return {
    completeCleanupBookkeeping,
    finalizeResumedAnnounceGiveUp,
    retireRunModeBundleMcpRuntime,
    startSubagentAnnounceCleanupFlow,
  };
}
