import type { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { reconcileOrphanedRun, safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { createInterruptedRecoveryCoordinator } from "./subagent-registry-restart-recovery-coordinator.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import {
  discardSuspendedPendingFinalDelivery,
  isSuspendedPendingFinalDelivery,
  resolveSuspendedDeliveryExpiryMs,
  SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP,
  SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT,
} from "./subagent-registry-suspended-delivery.js";
export { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import {
  reconcileDurableSubagentKillIntent,
  reconcileProvisionalSubagentKill,
} from "./subagent-registry-sweep-kill.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const STALE_ACTIVE_SUBAGENT_GRACE_MS = isFastTestRuntimeEnv() ? 1_000 : 60_000;
const restartRecoveryLoader = createLazyImportLoader(
  () => import("./subagent-registry-restart-recovery.js"),
);
const killRuntimeLoader = createLazyImportLoader(() => import("./subagent-control.runtime.js"));

type LifecycleController = ReturnType<typeof createSubagentRegistryLifecycleController>;
type LifecycleOptions = Parameters<typeof createSubagentRegistryLifecycleController>[0];

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
  abandonSubagentRestartRecoveryLaunch: ReturnType<
    typeof createSubagentRunManager
  >["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedSubagentRestartRecovery: ReturnType<
    typeof createSubagentRunManager
  >["clearAcceptedSubagentRestartRecovery"];
  resumeSettledSubagentRestartRecovery: ReturnType<
    typeof createSubagentRunManager
  >["resumeSettledSubagentRestartRecovery"];
  replaceSubagentRunAfterSteer: ReturnType<
    typeof createSubagentRunManager
  >["replaceSubagentRunAfterSteer"];
  markSubagentRestartRecoveryLaunchAttempted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAttempted"];
  markSubagentRestartRecoveryLaunchAccepted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAccepted"];
  markSubagentRestartRecoveryLaunchConsumed: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchConsumed"];
  reserveSubagentRestartRecoveryLaunch: ReturnType<
    typeof createSubagentRunManager
  >["reserveSubagentRestartRecoveryLaunch"];
  resetSubagentRestartRecoveryLaunchAttempt: ReturnType<
    typeof createSubagentRunManager
  >["resetSubagentRestartRecoveryLaunchAttempt"];
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
    getRunsForChildSession: params.getRunsForChildSession,
    getGatewayRuntime: params.getGatewayRecoveryRuntime,
    abandonLaunch: params.abandonSubagentRestartRecoveryLaunch,
    clearAcceptedRecovery: params.clearAcceptedSubagentRestartRecovery,
    resumeAcceptedRecovery: params.resumeSettledSubagentRestartRecovery,
    replaceRun: params.replaceSubagentRunAfterSteer,
    markLaunchAttempted: params.markSubagentRestartRecoveryLaunchAttempted,
    markLaunchAccepted: params.markSubagentRestartRecoveryLaunchAccepted,
    markLaunchConsumed: params.markSubagentRestartRecoveryLaunchConsumed,
    reserveLaunch: params.reserveSubagentRestartRecoveryLaunch,
    resetLaunchAttempt: params.resetSubagentRestartRecoveryLaunchAttempt,
    finalizeRun: params.finalizeInterruptedSubagentRun,
    recoverRow: async (recoveryParams) =>
      (await restartRecoveryLoader.load()).recoverInterruptedSubagentRow(recoveryParams),
    schedule: (delayMs) => schedule({ delayMs }),
    warn: params.warn,
  });

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
      params.warn(`subagent sweep ${label} failed`, { runId, error });
    });
  }

  type FrozenSessionIdentity = {
    sessionId: string;
    lifecycleRevision: string;
  };

  function freezeSessionIdentity(
    childSessionKey: string,
    storeCache: SubagentSessionStoreCache,
  ): FrozenSessionIdentity | undefined {
    const sessionEntry = loadSubagentSessionEntry({ childSessionKey, storeCache });
    const sessionId = sessionEntry?.sessionId?.trim();
    const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
    return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
  }

  async function deleteSession(
    childSessionKey: string,
    identity: FrozenSessionIdentity,
  ): Promise<"deleted" | "changed"> {
    let failure: unknown;
    const outcome = await deleteSubagentSessionForCleanup({
      callGateway: params.callGateway,
      childSessionKey,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
      onError: (error) => {
        failure = error;
      },
    });
    if (outcome === "failed") {
      throw failure;
    }
    return outcome;
  }

  const sweptContext = (entry: SubagentRunRecord) => ({
    childSessionKey: entry.childSessionKey,
    reason: "swept" as const,
    agentDir: entry.agentDir,
    workspaceDir: entry.workspaceDir,
  });

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
      recovery.prune();
      const suspendedEntries = runEntries.filter(([, entry]) =>
        isSuspendedPendingFinalDelivery(entry),
      );
      if (suspendedEntries.length >= SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT) {
        params.warn("subagent suspended delivery backlog exceeded pressure cap", {
          suspendedCount: suspendedEntries.length,
          softCap: SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT,
          hardCap: SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP,
          admissionBlocked: suspendedEntries.length >= SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP,
        });
      }
      for (const [runId, entry] of runEntries) {
        if (runs.get(runId) !== entry) {
          continue;
        }
        if (isRestoredQueuedFailureSettlementClaimed(entry)) {
          // The restored FIFO callback owns this row until durable settlement.
          continue;
        }
        if (entry.requesterSettleWake) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const expired =
            now - (entry.delivery?.suspendedAt ?? now) >= resolveSuspendedDeliveryExpiryMs();
          if (expired) {
            await discardSuspendedPendingFinalDelivery({
              runId,
              entry,
              now,
              reason: "expired",
              resumedRuns,
              clearPendingLifecycleError: params.clearPendingLifecycleError,
              clearPendingLifecycleTimeout: params.clearPendingLifecycleTimeout,
              completeCleanupBookkeeping: params.completeCleanupBookkeeping,
              shouldEmitEndedHookForRun: params.shouldEmitEndedHookForRun,
              emitSubagentEndedHookForRun: params.emitSubagentEndedHookForRun,
              warn: params.warn,
            });
            mutated = true;
            mutatedRunIds.add(runId);
          }
          continue;
        }
        if (entry.killIntent) {
          if (
            await reconcileDurableSubagentKillIntent({
              runId,
              entry,
              runs,
              getRunsForChildSession: params.getRunsForChildSession,
              loadKillRuntime: () => killRuntimeLoader.load(),
              completeSubagentRunWithRecovery: params.completeSubagentRunWithRecovery,
              retireSupersededRun: params.retireSupersededRun,
              warn: params.warn,
            })
          ) {
            mutated = true;
            mutatedRunIds.add(runId);
          }
          continue;
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
        if (
          (entry.execution.restartRecovery?.phase === "accepted" ||
            entry.terminalOwner === "interrupted-recovery" ||
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

        if (entry.collect && entry.collectorCompletion) {
          if (entry.collectorLaunchCleanupPending) {
            const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
            if (!suppressSessionEffects) {
              const sessionIdentity = freezeSessionIdentity(entry.childSessionKey, storeCache);
              if (!sessionIdentity) {
                entry.execution = {
                  ...entry.execution,
                  suppressSessionEffects: true,
                };
              } else {
                let deletion: "deleted" | "changed";
                try {
                  deletion = await deleteSession(entry.childSessionKey, sessionIdentity);
                } catch (error) {
                  params.warn("failed to retry collector launch cleanup", {
                    runId,
                    childSessionKey: entry.childSessionKey,
                    error,
                  });
                  continue;
                }
                if (runs.get(runId) !== entry) {
                  continue;
                }
                if (deletion === "changed") {
                  entry.execution = {
                    ...entry.execution,
                    suppressSessionEffects: true,
                  };
                } else {
                  if (!(await params.cleanupCollectorLaunchResources(entry))) {
                    continue;
                  }
                  if (runs.get(runId) !== entry) {
                    continue;
                  }
                  emitSessionLifecycleEvent({
                    sessionKey: entry.childSessionKey,
                    reason: "delete",
                    parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
                  });
                }
              }
            }
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
            if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
              runCleanupTail(runId, "context-engine cleanup", async () => {
                await params.notifyContextEngineSubagentEnded(sweptContext(entry));
              });
            }
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
        const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
        let sessionOwnershipChanged = false;
        if (!suppressSessionEffects) {
          const sessionIdentity = freezeSessionIdentity(entry.childSessionKey, storeCache);
          if (!sessionIdentity) {
            sessionOwnershipChanged = true;
          } else {
            try {
              sessionOwnershipChanged =
                (await deleteSession(entry.childSessionKey, sessionIdentity)) === "changed";
            } catch (error) {
              params.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
                runId,
                childSessionKey: entry.childSessionKey,
                error,
              });
              continue;
            }
            if (runs.get(runId) !== entry) {
              continue;
            }
          }
        }
        runs.delete(runId);
        mutated = true;
        mutatedRunIds.add(runId);
        await safeRemoveAttachmentsDir(entry);
        if (!suppressSessionEffects && !sessionOwnershipChanged) {
          runCleanupTail(runId, "context-engine cleanup", async () => {
            await params.notifyContextEngineSubagentEnded(sweptContext(entry));
          });
        }
      }
      for (const { requesterSessionKey, groupId } of collectorArchiveCandidates.values()) {
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
        let groupMembershipChanged = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          if (shouldSuppressSubagentRecoverySessionEffects(candidate)) {
            continue;
          }
          const sessionIdentity = freezeSessionIdentity(candidate.childSessionKey, storeCache);
          if (!sessionIdentity) {
            candidate.execution = {
              ...candidate.execution,
              suppressSessionEffects: true,
            };
            continue;
          }
          try {
            const deletion = await deleteSession(candidate.childSessionKey, sessionIdentity);
            if (runs.get(candidateRunId) !== candidate) {
              groupMembershipChanged = true;
              break;
            }
            if (deletion === "changed") {
              candidate.execution = {
                ...candidate.execution,
                suppressSessionEffects: true,
              };
            }
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
        if (deleteFailed || groupMembershipChanged) {
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
            shouldSuppressSubagentRecoverySessionEffects(candidate) ||
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
