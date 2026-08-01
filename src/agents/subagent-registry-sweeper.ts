import type { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { reconcileOrphanedRun, safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { createInterruptedRecoveryCoordinator } from "./subagent-registry-restart-recovery.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { reconcileProvisionalSubagentKill } from "./subagent-registry-sweep-kill.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const STALE_ACTIVE_SUBAGENT_GRACE_MS = isFastTestRuntimeEnv() ? 1_000 : 60_000;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;

type LifecycleController = ReturnType<typeof createSubagentRegistryLifecycleController>;
type LifecycleOptions = Parameters<typeof createSubagentRegistryLifecycleController>[0];

export async function retireSupersededSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  clearPendingLifecycleError: (runId: string) => void;
}): Promise<void> {
  const transcriptTarget = params.entry.execution.transcriptTarget;
  params.clearPendingLifecycleError(params.runId);
  params.runs.delete(params.runId);
  const transcriptStillOwned = Array.from(params.runs.values()).some((candidate) => {
    const candidateTarget = candidate.execution.transcriptTarget;
    return (
      candidateTarget?.sessionId === transcriptTarget?.sessionId &&
      candidateTarget?.sessionKey === transcriptTarget?.sessionKey &&
      candidateTarget?.storePath === transcriptTarget?.storePath
    );
  });
  if (transcriptTarget && !transcriptStillOwned) {
    await removeInternalSessionEffectsSession(transcriptTarget);
  }
  if (params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(params.entry);
  }
}

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: (...runIds: string[]) => void;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  replaceSubagentRunAfterSteer: ReturnType<
    typeof createSubagentRunManager
  >["replaceSubagentRunAfterSteer"];
  reserveSwarmCollectorLaunch: (runId: string, idempotencyKey: string) => boolean;
  finalizeInterruptedSubagentRun: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["finalizeInterruptedSubagentRun"];
  resumeRequesterSettleWake: LifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: LifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: LifecycleController["completeCleanupBookkeeping"];
  shouldEmitEndedHookForRun: LifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: LifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requesterSessionKey: string,
    groupId: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, resumedRuns } = params;
  let intervalStarted = false;
  let scheduledTimer: NodeJS.Timeout | null = null;
  let scheduledAt = Number.POSITIVE_INFINITY;
  let sweepInProgress = false;
  let rerunRequested = false;

  function start() {
    if (intervalStarted) {
      return;
    }
    intervalStarted = true;
    schedule({ delayMs: 60_000 });
  }

  function stop() {
    intervalStarted = false;
  }

  function schedule(options?: { delayMs?: number }) {
    const delayMs = Math.max(0, options?.delayMs ?? 5_000);
    const nextAt = Date.now() + delayMs;
    if (scheduledTimer && scheduledAt <= nextAt) {
      return;
    }
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
    }
    scheduledAt = nextAt;
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      scheduledAt = Number.POSITIVE_INFINITY;
      void runTick();
    }, delayMs);
    scheduledTimer.unref?.();
  }

  async function runTick() {
    if (sweepInProgress) {
      rerunRequested = true;
      return;
    }
    try {
      await runWithGatewayIndependentRootWorkAdmission(sweepOnce);
    } catch (error) {
      params.warn(
        `subagent run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (rerunRequested) {
        rerunRequested = false;
        schedule({ delayMs: 0 });
      } else if (intervalStarted) {
        schedule({ delayMs: 60_000 });
      }
    }
  }

  const recovery = createInterruptedRecoveryCoordinator({
    runs,
    getGatewayRuntime: params.getGatewayRecoveryRuntime,
    replaceRun: params.replaceSubagentRunAfterSteer,
    reserveCollectorLaunch: params.reserveSwarmCollectorLaunch,
    finalizeRun: params.finalizeInterruptedSubagentRun,
    recoverRow: recoverInterruptedSubagentRow,
    schedule: (delayMs) => schedule({ delayMs }),
    warn: params.warn,
  });

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
      params.warn(`subagent sweep ${label} failed`, { runId, error });
    });
  }

  function deleteSession(childSessionKey: string) {
    return params.callGateway({
      method: "sessions.delete",
      params: { key: childSessionKey, deleteTranscript: true, emitLifecycleHooks: false },
      timeoutMs: 10_000,
    });
  }

  const sweptContext = (entry: SubagentRunRecord) => ({
    childSessionKey: entry.childSessionKey,
    reason: "swept" as const,
    agentDir: entry.agentDir,
    workspaceDir: entry.workspaceDir,
  });

  function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
    return typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry);
  }

  function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
    const requester = entry.requesterSessionKey;
    return requester.includes(":cron:")
      ? SUSPENDED_DELIVERY_CRON_EXPIRY_MS
      : requester.includes(":subagent:")
        ? SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS
        : SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
  }

  async function discardSuspendedPendingFinalDelivery(
    runId: string,
    entry: SubagentRunRecord,
    now: number,
    reason: "expired" | "pressure-pruned",
  ): Promise<void> {
    const delivery = ensureDeliveryState(entry);
    const payload = delivery.payload;
    delivery.status = "discarded";
    delivery.discardedAt = now;
    delivery.discardReason = reason;
    delivery.discardedPayloadSummary = {
      requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
      childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
      childRunId: payload?.childRunId ?? entry.runId,
      endedAt: payload?.endedAt ?? entry.execution.endedAt,
      status: payload?.outcome?.status ?? entry.execution.outcome?.status,
      lastError: getDeliveryLastError(entry) ?? null,
    };
    delivery.payload = undefined;
    delivery.createdAt = undefined;
    delivery.lastAttemptAt = undefined;
    delivery.attemptCount = undefined;
    delivery.lastError = undefined;
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    entry.cleanupHandled = true;
    delivery.announcedAt = undefined;
    resumedRuns.delete(runId);
    params.clearPendingLifecycleError(runId);
    params.clearPendingLifecycleTimeout(runId);
    params.warn("subagent suspended delivery discarded", {
      reason,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
    });
    const shouldDeleteAttachments = entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    await removeInternalSessionEffectsSession(entry.execution.transcriptTarget);
    const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    params.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: entry.cleanup,
      completedAt: now,
      // The requester settle wake already ran when this delivery was suspended.
      skipRequesterSettleWake: true,
    });
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({ entry, reason: completionReason })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: completionReason,
        sendFarewell: true,
      });
    }
  }

  async function sweepOnce() {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    try {
      const now = Date.now();
      const storeCache: SubagentSessionStoreCache = new Map();
      let mutated = false;
      const mutatedRunIds = new Set<string>();
      const collectorArchiveCandidates = new Map<
        string,
        { requesterSessionKey: string; groupId: string }
      >();
      const phase = ([runId, entry]: [string, SubagentRunRecord]) =>
        entry.requesterSettleWake
          ? 0
          : isSuspendedPendingFinalDelivery(entry)
            ? 1
            : entry.terminalOwner === "interrupted-recovery"
              ? 2
              : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
                ? 3
                : entry.killReconciliation
                  ? 4
                  : 5;
      // One exact-row snapshot enforces phase order without letting replacements reenter this tick.
      const runEntries = [...runs.entries()].toSorted((left, right) => {
        const phaseDelta = phase(left) - phase(right);
        return (
          phaseDelta ||
          (phase(left) === 3
            ? Number(isStaleUnendedSubagentRun(right[1], now)) -
              Number(isStaleUnendedSubagentRun(left[1], now))
            : 0)
        );
      });
      recovery.prune(runEntries);
      const suspendedEntries = runEntries.filter(([, entry]) =>
        isSuspendedPendingFinalDelivery(entry),
      );
      const pressureDiscardRunIds = new Set<string>();
      if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
        const pressureCount = Math.max(
          0,
          suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET,
        );
        for (const [runId] of suspendedEntries
          .toSorted((a, b) => (a[1].delivery?.suspendedAt ?? 0) - (b[1].delivery?.suspendedAt ?? 0))
          .slice(0, pressureCount)) {
          pressureDiscardRunIds.add(runId);
        }
        params.warn("subagent suspended delivery backlog exceeded pressure cap", {
          suspendedCount: suspendedEntries.length,
          softCap: SUSPENDED_DELIVERY_SOFT_CAP,
          hardCap: SUSPENDED_DELIVERY_HARD_CAP,
          pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
          pressureDiscardCount: pressureDiscardRunIds.size,
        });
      }
      for (const [runId, entry] of runEntries) {
        if (runs.get(runId) !== entry) {
          continue;
        }
        if (entry.requesterSettleWake) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const expired =
            now - (entry.delivery?.suspendedAt ?? now) >= resolveSuspendedDeliveryExpiryMs(entry);
          if (expired || pressureDiscardRunIds.has(runId)) {
            await discardSuspendedPendingFinalDelivery(
              runId,
              entry,
              now,
              expired ? "expired" : "pressure-pruned",
            );
            mutated = true;
            mutatedRunIds.add(runId);
          }
          continue;
        }
        if (
          (entry.terminalOwner === "interrupted-recovery" ||
            (!getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number")) &&
          (await recovery.recover(runId, entry, now))
        ) {
          continue;
        }
        if (typeof entry.execution.endedAt !== "number") {
          const hasLiveRunContext = Boolean(getAgentRunContext(runId));
          const activeAgeMs = now - (entry.execution.startedAt ?? entry.createdAt);
          if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
            const orphanReason = resolveSubagentRunOrphanReason({ entry });
            if (orphanReason) {
              if (
                reconcileOrphanedRun({
                  runId,
                  entry,
                  reason: orphanReason,
                  source: "resume",
                  runs,
                  resumedRuns,
                })
              ) {
                mutated = true;
                mutatedRunIds.add(runId);
              }
              continue;
            }

            const sessionEntry = loadSubagentSessionEntry({
              childSessionKey: entry.childSessionKey,
              storeCache,
            });
            const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
              notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
            });
            if (completion) {
              await params.completeSubagentRunWithRecovery(
                {
                  runId,
                  startedAt: completion.startedAt,
                  endedAt: completion.endedAt,
                  outcome: completion.outcome,
                  reason: completion.reason,
                  sendFarewell: true,
                  accountId: entry.requesterOrigin?.accountId,
                  triggerCleanup: true,
                },
                "sweeper-session-completion",
              );
              continue;
            }

            await params.completeSubagentRunWithRecovery(
              {
                runId,
                endedAt: now,
                outcome: {
                  status: "error",
                  error: "subagent run lost active execution context",
                },
                reason: SUBAGENT_ENDED_REASON_ERROR,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-lost-context",
            );
            continue;
          }
        }

        if (entry.killReconciliation) {
          const reconciled = await reconcileProvisionalSubagentKill({
            runId,
            entry,
            now,
            runs,
            storeCache,
            completeSubagentRunWithRecovery: params.completeSubagentRunWithRecovery,
            retireSupersededRun: params.retireSupersededRun,
            startSubagentAnnounceCleanupFlow: params.startSubagentAnnounceCleanupFlow,
            getRunsForChildSession: params.getRunsForChildSession,
            warn: params.warn,
          });
          if (reconciled) {
            mutated = true;
            mutatedRunIds.add(runId);
          }
          continue;
        }
        if (entry.collect && entry.collectorCompletion) {
          if (entry.collectorLaunchCleanupPending) {
            try {
              await deleteSession(entry.childSessionKey);
            } catch (error) {
              params.warn("failed to retry collector launch cleanup", {
                runId,
                childSessionKey: entry.childSessionKey,
                error,
              });
              continue;
            }
            if (!(await params.cleanupCollectorLaunchResources(entry))) {
              continue;
            }
            emitSessionLifecycleEvent({
              sessionKey: entry.childSessionKey,
              reason: "delete",
              parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
            });
            entry.collectorLaunchCleanupPending = false;
            entry.cleanupCompletedAt = now;
            mutated = true;
            mutatedRunIds.add(runId);
          }
          const groupId = entry.groupId?.trim();
          const swarmRequesterSessionKey =
            entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
          const groupKey = groupId
            ? JSON.stringify([swarmRequesterSessionKey, groupId])
            : undefined;
          if (groupKey && groupId) {
            collectorArchiveCandidates.set(groupKey, {
              requesterSessionKey: swarmRequesterSessionKey,
              groupId,
            });
          }
          continue;
        }
        if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") {
          continue;
        }
        if (!entry.archiveAtMs) {
          if (
            typeof entry.cleanupCompletedAt === "number" &&
            now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
          ) {
            params.clearPendingLifecycleError(runId);
            runCleanupTail(runId, "context-engine cleanup", async () => {
              await params.notifyContextEngineSubagentEnded(sweptContext(entry));
            });
            runs.delete(runId);
            mutated = true;
            mutatedRunIds.add(runId);
            if (!entry.retainAttachmentsOnKeep) {
              await safeRemoveAttachmentsDir(entry);
            }
          }
          continue;
        }
        if (entry.archiveAtMs > now) {
          continue;
        }
        params.clearPendingLifecycleError(runId);
        try {
          await deleteSession(entry.childSessionKey);
        } catch (error) {
          params.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
            runId,
            childSessionKey: entry.childSessionKey,
            error,
          });
          continue;
        }
        runs.delete(runId);
        mutated = true;
        mutatedRunIds.add(runId);
        await safeRemoveAttachmentsDir(entry);
        runCleanupTail(runId, "context-engine cleanup", async () => {
          await params.notifyContextEngineSubagentEnded(sweptContext(entry));
        });
      }
      for (const { requesterSessionKey, groupId } of collectorArchiveCandidates.values()) {
        // Re-read the mutation-owned index after awaited per-run collector cleanup.
        const groupEntries = [...params.getRunsForCollectorGroup(requesterSessionKey, groupId)];
        if (
          groupEntries.some(
            ([, candidate]) =>
              !candidate.collectorCompletion ||
              candidate.collectorLaunchCleanupPending === true ||
              candidate.archiveAtMs === undefined ||
              candidate.archiveAtMs > now,
          )
        ) {
          continue;
        }
        let deleteFailed = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          try {
            await deleteSession(candidate.childSessionKey);
          } catch (error) {
            params.warn("sessions.delete failed during collector group sweep; keeping group", {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
              error,
            });
            deleteFailed = true;
            break;
          }
        }
        if (deleteFailed) {
          continue;
        }
        let attachmentCleanupFailed = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          if (await safeRemoveAttachmentsDir(candidate)) {
            continue;
          }
          params.warn("attachment cleanup failed during collector group sweep; keeping group", {
            runId: candidateRunId,
            childSessionKey: candidate.childSessionKey,
            groupId,
          });
          attachmentCleanupFailed = true;
          break;
        }
        if (attachmentCleanupFailed) {
          continue;
        }
        let contextCleanupFailed = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          if (
            candidate.cleanup === "delete" ||
            typeof candidate.contextEngineCleanupCompletedAt === "number"
          ) {
            continue;
          }
          try {
            await params.runContextEngineSubagentEnded(sweptContext(candidate));
            candidate.contextEngineCleanupCompletedAt = Date.now();
            params.persist(candidateRunId);
          } catch (error) {
            params.warn(
              "context-engine cleanup failed during collector group sweep; keeping group",
              {
                runId: candidateRunId,
                childSessionKey: candidate.childSessionKey,
                groupId,
                error,
              },
            );
            contextCleanupFailed = true;
            break;
          }
        }
        if (contextCleanupFailed) {
          continue;
        }
        // Delete only the exact group snapshot; awaited cleanup can change membership.
        const expectedGroupEntries = new Map(groupEntries);
        const liveGroupEntries = [...params.getRunsForCollectorGroup(requesterSessionKey, groupId)];
        if (
          liveGroupEntries.length !== groupEntries.length ||
          liveGroupEntries.some(
            ([candidateRunId, candidate]) =>
              expectedGroupEntries.get(candidateRunId) !== candidate ||
              !candidate.collectorCompletion ||
              candidate.collectorLaunchCleanupPending === true ||
              candidate.archiveAtMs === undefined ||
              candidate.archiveAtMs > now,
          )
        ) {
          continue;
        }
        for (const [candidateRunId] of liveGroupEntries) {
          params.clearPendingLifecycleError(candidateRunId);
          runs.delete(candidateRunId);
          mutatedRunIds.add(candidateRunId);
        }
        mutated = true;
      }
      params.sweepPendingLifecycle(now);

      if (mutated) {
        params.persist(...mutatedRunIds);
      }
      if (runs.size === 0) {
        stop();
      }
    } finally {
      sweepInProgress = false;
    }
  }

  return {
    start,
    stop,
    schedule,
    sweepOnce,
    runTick,
    reset() {
      stop();
      if (scheduledTimer) {
        clearTimeout(scheduledTimer);
      }
      scheduledTimer = null;
      scheduledAt = Number.POSITIVE_INFINITY;
      recovery.reset();
      rerunRequested = false;
      intervalStarted = false;
      sweepInProgress = false;
    },
  };
}
