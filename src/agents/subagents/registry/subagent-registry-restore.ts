import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  GatewayDrainingError,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import {
  backfillSubagentRequesterAgentIds,
  resolveSubagentRequesterAgentId,
} from "../../subagent-requester-owner.js";
import { applySubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import { retrySubagentCleanup } from "../spawn/subagent-spawn-cleanup.js";
import { readGatewayRunId } from "../spawn/subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import {
  reconcileOrphanedRestoredRuns,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

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

const RESTORE_RETRY_DELAY_MS = 1_000;
const RESTORE_RETRY_MAX_DELAY_MS = 30_000;

export function isRestoredQueuedFailureSettlementClaimed(entry: SubagentRunRecord): boolean {
  return restoredQueuedFailureSettlementClaims.has(entry);
}

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  deps: () => SubagentRegistryDeps;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  ensureListener: () => void;
  startSweeper: () => void;
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: (
    groupId: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ) => SubagentRunRecord[];
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
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    resumedRuns,
    deps,
    getGatewayContextResolver,
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
    warn,
  } = config;
  let restoreState: "idle" | "in-progress" | "succeeded" = "idle";
  let activationRequested = false;
  let activated = false;
  // A dependency can merge rows before throwing. Keep their reconciliation
  // pending because mergeOnly correctly reports them as existing on retry.
  let restoredRowsPending = false;
  let restoreRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearRestoreRetryTimer() {
    if (restoreRetryTimer) {
      clearTimeout(restoreRetryTimer);
      restoreRetryTimer = undefined;
    }
  }

  function scheduleRestoreRetry(delayMs: number) {
    if (restoreRetryTimer) {
      return;
    }
    const timer = setTimeout(() => {
      if (restoreRetryTimer !== timer) {
        return;
      }
      restoreRetryTimer = undefined;
      restoreSubagentRunsOnce(Math.min(delayMs * 2, RESTORE_RETRY_MAX_DELAY_MS));
    }, delayMs);
    restoreRetryTimer = timer;
    timer.unref?.();
  }

  function completeRestore() {
    restoredRowsPending = false;
    restoreState = "succeeded";
    clearRestoreRetryTimer();
    if (activationRequested) {
      activateRestoredRuns();
    }
  }

  function activateRestoredRuns() {
    activationRequested = true;
    if (restoreState !== "succeeded" || activated) {
      return;
    }
    const cfg = deps().getRuntimeConfig();
    const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
    const resolveRequesterAgentId = (entry: SubagentRunRecord) =>
      resolveSubagentRequesterAgentId(cfg, entry);
    for (const entry of runs.values()) {
      const requesterTurnRunId = entry.requesterTurnRunId?.trim();
      if (!requesterTurnRunId) {
        continue;
      }
      const requesterIdentity = `${resolveRequesterAgentId(entry) ?? "unknown"}\0${entry.requesterSessionKey}`;
      let turns = requesterTurns.get(requesterIdentity);
      if (!turns) {
        turns = new Map();
        requesterTurns.set(requesterIdentity, turns);
      }
      const entries = turns.get(requesterTurnRunId) ?? [];
      entries.push(entry);
      turns.set(requesterTurnRunId, entries);
    }
    for (const [, turns] of requesterTurns) {
      for (const [requesterTurnRunId, entries] of turns) {
        const firstEntry = entries[0];
        if (!firstEntry) {
          continue;
        }
        settleRequesterTurn({
          requesterSessionKey: firstEntry.requesterSessionKey,
          requesterAgentId: resolveRequesterAgentId(firstEntry),
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
      activated = true;
      return;
    }

    ensureListener();
    // Session-mode runs have no archive deadline but still need TTL cleanup.
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
          entry.requesterAgentId,
        );
        const currentSwarmConfig = resolveSwarmConfig(cfg, entry.requesterAgentId);
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
              const request = {
                params: applySubagentLaunchAuthorization(launch.request, launch.authorization),
                timeoutMs: launch.timeoutMs,
              };
              const gatewayRuntime = getGatewayContextResolver()?.()?.recoveryRuntime;
              if (!gatewayRuntime) {
                throw new GatewayDrainingError();
              }
              const response = await gatewayRuntime.dispatchAgent(
                request.params as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
                request.timeoutMs,
                launch.authorization
                  ? { allowModelOverride: true, scopes: [ADMIN_SCOPE] }
                  : undefined,
              );
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
    activated = true;
  }

  function restoreSubagentRunsOnce(retryDelayMs = RESTORE_RETRY_DELAY_MS) {
    if (restoreState !== "idle") {
      return;
    }
    restoreState = "in-progress";
    const runCountBeforeRestore = runs.size;
    try {
      const restoredCount = deps().restoreSubagentRunsFromDisk({
        runs,
        mergeOnly: true,
      });
      restoredRowsPending ||= restoredCount > 0;
      if (!restoredRowsPending) {
        completeRestore();
        return;
      }
      const cfg = deps().getRuntimeConfig();
      let restoredStateChanged = reconcileOrphanedRestoredRuns({
        runs,
        resumedRuns,
      });
      if (backfillSubagentRequesterAgentIds(cfg, runs.values()) > 0) {
        restoredStateChanged = true;
      }
      for (const entry of runs.values()) {
        if (updateSubagentArchiveAtMs(entry, cfg)) {
          restoredStateChanged = true;
        }
      }
      if (restoredStateChanged) {
        persist();
      }
      completeRestore();
    } catch (err) {
      restoredRowsPending ||= runs.size > runCountBeforeRestore;
      restoreState = "idle";
      warn(
        `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleRestoreRetry(retryDelayMs);
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
    activate: activateRestoredRuns,
    reset: () => {
      clearRestoreRetryTimer();
      restoreState = "idle";
      restoredRowsPending = false;
      activationRequested = false;
      activated = false;
    },
  };
}
