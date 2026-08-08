import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  GatewayDrainingError,
} from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { applySubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import {
  backfillCollectorArchiveAtMs,
  reconcileOrphanedRestoredRuns,
} from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import { retrySubagentCleanup } from "./subagent-spawn-cleanup.js";
import { readGatewayRunId } from "./subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { enqueueSwarmRun } from "./swarm-scheduler.js";

type RestoredQueuedFailureSettlementClaim = {
  entry: SubagentRunRecord;
  runId: string;
  execution: SubagentRunRecord["execution"];
  queuedLaunch: SubagentRunRecord["queuedLaunch"];
  killIntent: SubagentRunRecord["killIntent"];
  killReconciliation: SubagentRunRecord["killReconciliation"];
};

const restoredQueuedFailureSettlementClaims = new WeakMap<
  SubagentRunRecord,
  RestoredQueuedFailureSettlementClaim
>();

export function isRestoredQueuedFailureSettlementClaimed(entry: SubagentRunRecord): boolean {
  return restoredQueuedFailureSettlementClaims.has(entry);
}

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  deps: () => SubagentRegistryDeps;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  settleRequesterTurn: ReturnType<
    typeof createSubagentRegistryLifecycleController
  >["settleRequesterTurnAfterSessionSpawns"];
  ensureListener: () => void;
  startSweeper: () => void;
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: (groupId: string, requesterSessionKey?: string) => SubagentRunRecord[];
  startQueuedSubagentRun: (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
  ) => boolean;
  terminateAcceptedRestoredCollectorRun: (params: {
    entry: SubagentRunRecord;
    gatewayRunId: string;
    timeoutMs: number;
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  }) => Promise<void>;
  cleanupCollectorLaunchResources: (
    entry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ) => Promise<boolean>;
  settleFailedQueuedSubagentLaunch: (runId: string, error: string) => boolean;
  completeCollectorLaunchCleanup: (runId: string) => void;
  scheduleSweep: (params?: { delayMs?: number }) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    resumedRuns,
    deps,
    persist,
    persistOrThrow,
    settleRequesterTurn,
    ensureListener,
    startSweeper,
    resumeRun,
    listSwarmRunsForGroup,
    startQueuedSubagentRun,
    terminateAcceptedRestoredCollectorRun,
    cleanupCollectorLaunchResources,
    settleFailedQueuedSubagentLaunch,
    completeCollectorLaunchCleanup,
    scheduleSweep,
    warn,
  } = config;
  let restoreAttempted = false;

  function restoreSubagentRunsOnce() {
    if (restoreAttempted) {
      return;
    }
    restoreAttempted = true;
    try {
      const restoredCount = deps().restoreSubagentRunsFromDisk({
        runs,
        mergeOnly: true,
      });
      if (restoredCount === 0) {
        return;
      }
      const cfg = deps().getRuntimeConfig();
      let restoredStateChanged = reconcileOrphanedRestoredRuns({
        runs,
        resumedRuns,
      });
      for (const entry of runs.values()) {
        if (backfillCollectorArchiveAtMs(entry, cfg)) {
          restoredStateChanged = true;
        }
      }
      if (restoredStateChanged) {
        persist();
      }
      const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
      for (const entry of runs.values()) {
        const requesterTurnRunId = entry.requesterTurnRunId?.trim();
        if (!requesterTurnRunId) {
          continue;
        }
        let turns = requesterTurns.get(entry.requesterSessionKey);
        if (!turns) {
          turns = new Map();
          requesterTurns.set(entry.requesterSessionKey, turns);
        }
        const entries = turns.get(requesterTurnRunId) ?? [];
        entries.push(entry);
        turns.set(requesterTurnRunId, entries);
      }
      for (const [requesterSessionKey, turns] of requesterTurns) {
        for (const [requesterTurnRunId, entries] of turns) {
          settleRequesterTurn({
            requesterSessionKey,
            requesterTurnRunId,
            requesterYielded: entries.every((entry) => entry.requesterTurnYielded === true),
            acceptedSessionSpawns: entries.map((entry) => ({
              runId: entry.taskRunId ?? entry.runId,
              childSessionKey: entry.childSessionKey,
            })),
          });
        }
      }
      if (runs.size === 0) {
        return;
      }
      // Resume pending work.
      ensureListener();
      // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
      startSweeper();
      const restoredSessionCache: SubagentSessionStoreCache = new Map();
      for (const [runId, entry] of runs) {
        // Restart recovery exclusively owns receipt-bearing source rows until it
        // remaps or terminalizes them. Generic resume would wait on an obsolete run.
        if (entry.execution.restartRecovery || entry.killIntent || entry.killReconciliation) {
          continue;
        }
        if (entry.collect && entry.execution.status === "queued") {
          const cleanupSessionEntry = loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache: restoredSessionCache,
          });
          const launch = entry.queuedLaunch;
          if (!launch) {
            const cleanupLifecycleGeneration = getAgentEventLifecycleGeneration();
            void failAndCleanupRestoredQueuedRun(
              runId,
              entry,
              "queued collector launch state was unavailable after restart",
              false,
              cleanupLifecycleGeneration,
              cleanupSessionEntry?.sessionId,
              cleanupSessionEntry?.lifecycleRevision,
            );
            continue;
          }
          const groupRuns = listSwarmRunsForGroup(
            entry.groupId ?? "",
            entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
          );
          const currentSwarmConfig = resolveSwarmConfig(
            deps().getRuntimeConfig(),
            entry.requesterAgentId,
          );
          let launchTerminationConfirmed = false;
          let launchLifecycleGeneration: string | undefined;
          enqueueSwarmRun({
            groupId: launch.schedulerGroupKey,
            runId,
            maxConcurrent: currentSwarmConfig.maxConcurrent,
            activeRunIds: groupRuns
              .filter((candidate) => candidate.execution.status === "running")
              .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
            start: async () => {
              await runWithGatewayIndependentRootWorkAdmission(async () => {
                launchLifecycleGeneration = getAgentEventLifecycleGeneration();
                const response = await deps().callGateway({
                  method: "agent",
                  params: applySubagentLaunchAuthorization(launch.request, launch.authorization),
                  // Restart replay must restore the trusted launch capability; otherwise
                  // the queued child silently falls back to its session/default route.
                  ...(launch.authorization ? { scopes: [ADMIN_SCOPE] } : {}),
                  timeoutMs: launch.timeoutMs,
                });
                const gatewayRunId = readGatewayRunId(response) ?? runId;
                try {
                  if (!startQueuedSubagentRun(runId, gatewayRunId, launchLifecycleGeneration)) {
                    throw new Error(
                      "collector registry row could not transition from queued to running",
                    );
                  }
                } catch (error) {
                  await terminateAcceptedRestoredCollectorRun({
                    entry,
                    gatewayRunId,
                    timeoutMs: launch.timeoutMs,
                    expectedSessionId: cleanupSessionEntry?.sessionId,
                    expectedLifecycleRevision: cleanupSessionEntry?.lifecycleRevision,
                  });
                  launchTerminationConfirmed = true;
                  throw error;
                }
              });
            },
            onStartFailure: (error) => {
              if (error instanceof GatewayDrainingError) {
                return false;
              }
              return failAndCleanupRestoredQueuedRun(
                runId,
                entry,
                error instanceof Error ? error.message : String(error),
                launchTerminationConfirmed,
                launchLifecycleGeneration ?? getAgentEventLifecycleGeneration(),
                cleanupSessionEntry?.sessionId,
                cleanupSessionEntry?.lifecycleRevision,
              );
            },
          });
          continue;
        }
        // An aborted persisted session belongs to orphan recovery. Waiting on its
        // pre-restart run can terminalize it before the replacement turn starts.
        if (
          loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache: restoredSessionCache,
          })?.abortedLastRun === true
        ) {
          continue;
        }
        resumeRun(runId);
      }

      // Cold-start restore can precede instance-runtime registration. The post-attach
      // startup pass retries this seam once the lifecycle-bound principal exists.
      scheduleSweep();
    } catch (err) {
      warn(
        `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function failAndCleanupRestoredQueuedRun(
    runId: string,
    entry: SubagentRunRecord,
    error: string,
    launchTerminationConfirmed: boolean,
    lifecycleGeneration: string,
    expectedSessionId?: string,
    expectedLifecycleRevision?: string,
  ): Promise<boolean> {
    if (runs.get(runId) !== entry || entry.execution.status !== "queued") {
      return true;
    }
    const claim: RestoredQueuedFailureSettlementClaim = {
      entry,
      runId,
      execution: entry.execution,
      queuedLaunch: entry.queuedLaunch,
      killIntent: entry.killIntent,
      killReconciliation: entry.killReconciliation,
    };
    restoredQueuedFailureSettlementClaims.set(entry, claim);
    const refreshClaim = () => {
      claim.execution = entry.execution;
      claim.queuedLaunch = entry.queuedLaunch;
      claim.killIntent = entry.killIntent;
      claim.killReconciliation = entry.killReconciliation;
    };
    const ownsClaim = () =>
      restoredQueuedFailureSettlementClaims.get(entry) === claim &&
      runs.get(runId) === entry &&
      entry.runId === runId &&
      entry.execution === claim.execution &&
      entry.queuedLaunch === claim.queuedLaunch &&
      entry.killIntent === claim.killIntent &&
      entry.killReconciliation === claim.killReconciliation;
    const ownsCleanup = () =>
      ownsClaim() && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
    let sessionOwnershipChanged = false;
    let sessionDeleted = false;
    try {
      const cleanupComplete = await runWithGatewayIndependentRootWorkAdmission(async () => {
        if (!ownsCleanup()) {
          return false;
        }
        if (!expectedSessionId || !expectedLifecycleRevision) {
          sessionOwnershipChanged = true;
          return true;
        }
        const cleanupSettled = await retrySubagentCleanup(
          async () => {
            if (!ownsCleanup()) {
              return false;
            }
            const outcome = await deleteSubagentSessionForCleanup({
              callGateway: deps().callGateway,
              childSessionKey: entry.childSessionKey,
              expectedSessionId,
              expectedLifecycleRevision,
              onError: (cleanupError) => {
                throw cleanupError;
              },
            });
            sessionDeleted = outcome === "deleted";
            sessionOwnershipChanged = outcome === "changed";
            return outcome !== "failed";
          },
          {
            shouldRetry: () => !launchTerminationConfirmed && ownsCleanup(),
            onError: (cleanupError) =>
              warn("failed to delete restored collector session after launch failure", {
                runId,
                childSessionKey: entry.childSessionKey,
                error: cleanupError,
              }),
          },
        );
        if (!cleanupSettled || !ownsCleanup() || sessionOwnershipChanged) {
          return cleanupSettled && ownsCleanup();
        }
        return await cleanupCollectorLaunchResources(entry, { isCurrent: ownsCleanup });
      }).catch((cleanupError: unknown) => {
        warn("failed to clean restored collector after launch failure", {
          runId,
          childSessionKey: entry.childSessionKey,
          error: cleanupError,
        });
        return false;
      });

      if (!ownsClaim()) {
        const current = runs.get(runId);
        return current !== entry || current.execution.status !== "queued";
      }
      let failureSettled = false;
      await retrySubagentCleanup(
        async () => {
          if (!ownsClaim()) {
            const current = runs.get(runId);
            return current !== entry || current.execution.status !== "queued";
          }
          if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
            // Lifecycle rotation retires external session effects, not the durable
            // failure fact. Keep settling the exact row so the collector receives
            // a visible terminal outcome before its FIFO slot is released.
            entry.execution = {
              ...entry.execution,
              suppressSessionEffects: true,
            };
            refreshClaim();
          }
          try {
            failureSettled = settleFailedQueuedSubagentLaunch(runId, error);
            return failureSettled;
          } catch (persistError) {
            // The run manager restores the queued snapshot on a failed write.
            // Refresh only after that synchronous rollback; other owners cannot
            // mutate this claimed row through the sweeper/recovery lane.
            refreshClaim();
            throw persistError;
          }
        },
        {
          shouldRetry: ownsClaim,
          onError: (persistError) =>
            warn("failed to persist restored collector launch failure", {
              runId,
              childSessionKey: entry.childSessionKey,
              error: persistError,
            }),
        },
      );
      if (!failureSettled) {
        const current = runs.get(runId);
        return current !== entry || current.execution.status !== "queued";
      }
      if (
        runs.get(runId) === entry &&
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        entry.execution.suppressSessionEffects !== true
      ) {
        const previousExecution = entry.execution;
        entry.execution = {
          ...entry.execution,
          suppressSessionEffects: true,
        };
        try {
          persistOrThrow(runId);
        } catch (persistError) {
          entry.execution = previousExecution;
          throw persistError;
        }
      }
      if (cleanupComplete && runs.get(runId) === entry) {
        if (sessionDeleted && !sessionOwnershipChanged) {
          emitSessionLifecycleEvent({
            sessionKey: entry.childSessionKey,
            reason: "delete",
            parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
          });
        }
        completeCollectorLaunchCleanup(runId);
      }
      return true;
    } finally {
      if (restoredQueuedFailureSettlementClaims.get(entry) === claim) {
        restoredQueuedFailureSettlementClaims.delete(entry);
      }
    }
  }

  return {
    restoreOnce: restoreSubagentRunsOnce,
    reset: () => {
      restoreAttempted = false;
    },
  };
}
