import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  GatewayDrainingError,
} from "../../../process/gateway-work-admission.js";
import { applySubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import { readGatewayRunId } from "../spawn/subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import {
  enqueueSwarmRun,
  restoreActiveSwarmRun,
  type SwarmStartFailureDisposition,
} from "../swarm/swarm-scheduler.js";
import type { AcceptedRunTermination } from "./subagent-accepted-run-termination.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import {
  reconcileOrphanedRestoredRuns,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const RESTORE_RETRY_DELAY_MS = 1_000;
const RESTORE_RETRY_MAX_DELAY_MS = 30_000;

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  deps: () => SubagentRegistryDeps;
  persist: (...runIds: string[]) => void;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  ensureListener: () => void;
  startSweeper: () => void;
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: (groupId: string, requesterSessionKey?: string) => SubagentRunRecord[];
  startQueuedSubagentRun: (
    runId: string,
    gatewayRunId?: string,
    expectedTermination?: AcceptedRunTermination,
  ) => boolean;
  recordAcceptedRunTermination: (
    runId: string,
    termination: NonNullable<SubagentRunRecord["acceptedRunTermination"]>,
  ) => void;
  markAcceptedRunTerminationPending: (
    runId: string,
    termination: NonNullable<SubagentRunRecord["acceptedRunTermination"]>,
  ) => boolean;
  terminateAcceptedRestoredCollectorRun: (params: {
    entry: SubagentRunRecord;
    ownerRunId: string;
    timeoutMs: number;
  }) => Promise<boolean>;
  settleFailedQueuedSubagentLaunch: (
    runId: string,
    error: string,
    options?: { suppressSessionEffects?: boolean },
  ) => boolean;
  scheduleSweep: (params?: { delayMs?: number }) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    resumedRuns,
    deps,
    persist,
    settleRequesterTurn,
    ensureListener,
    startSweeper,
    resumeRun,
    listSwarmRunsForGroup,
    startQueuedSubagentRun,
    recordAcceptedRunTermination,
    markAcceptedRunTerminationPending,
    terminateAcceptedRestoredCollectorRun,
    settleFailedQueuedSubagentLaunch,
    scheduleSweep,
    warn,
  } = config;
  let restoreState: "idle" | "in-progress" | "succeeded" = "idle";
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
      const deferredCleanupRunIds = new Set<string>();
      let restoredStateChanged = reconcileOrphanedRestoredRuns({
        runs,
        resumedRuns,
        deferredCleanupRunIds,
      });
      for (const entry of runs.values()) {
        if (updateSubagentArchiveAtMs(entry, cfg)) {
          restoredStateChanged = true;
        }
      }
      if (restoredStateChanged) {
        persist();
      }
      const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
      for (const entry of runs.values()) {
        if (deferredCleanupRunIds.has(entry.runId)) {
          continue;
        }
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
            // Deferred orphans remain durable cleanup owners, not members of the
            // surviving requester batch being settled during this restore pass.
            ignoredRunIds: deferredCleanupRunIds,
          });
        }
      }
      if (runs.size === 0) {
        completeRestore();
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
        if (!entry.collect && entry.execution.status === "queued" && entry.launchCleanupPending) {
          void failAndCleanupRestoredQueuedRun(
            runId,
            entry,
            "subagent launch was interrupted before activation",
            getAgentEventLifecycleGeneration(),
          );
          continue;
        }
        if (entry.collect && entry.execution.status === "queued") {
          const cleanupSessionEntry = loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache: restoredSessionCache,
          });
          const cleanupSessionId = entry.launchCleanupPending
            ? entry.launchCleanupSessionIdentity?.sessionId
            : cleanupSessionEntry?.sessionId;
          const cleanupSessionLifecycleRevision = entry.launchCleanupPending
            ? entry.launchCleanupSessionIdentity?.lifecycleRevision
            : cleanupSessionEntry?.lifecycleRevision;
          const launch = entry.queuedLaunch;
          if (!launch) {
            const cleanupLifecycleGeneration = getAgentEventLifecycleGeneration();
            void failAndCleanupRestoredQueuedRun(
              runId,
              entry,
              "queued collector launch state was unavailable after restart",
              cleanupLifecycleGeneration,
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
          if (entry.acceptedRunTermination) {
            restoreActiveSwarmRun({
              groupId: launch?.schedulerGroupKey ?? entry.groupId ?? runId,
              runId: entry.schedulerSlotId ?? runId,
              maxConcurrent: currentSwarmConfig.maxConcurrent,
              activeRunIds: groupRuns
                .filter((candidate) => candidate.execution.status === "running")
                .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
            });
            continue;
          }
          let launchTerminationConfirmed = false;
          let launchTerminationPending = false;
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
                const dispatchLifecycleGeneration = getAgentEventLifecycleGeneration();
                launchLifecycleGeneration = dispatchLifecycleGeneration;
                const request = {
                  method: "agent",
                  params: applySubagentLaunchAuthorization(launch.request, launch.authorization),
                  // Restart replay must restore the trusted launch capability; otherwise
                  // the queued child silently falls back to its session/default route.
                  ...(launch.authorization ? { scopes: [ADMIN_SCOPE] } : {}),
                  timeoutMs: launch.timeoutMs,
                };
                const gatewayRuntime = deps().getGatewayRecoveryRuntime();
                const terminationOwner = {
                  kind: "launch" as const,
                  phase: "attempted" as const,
                  gatewayRunId: runId,
                  lifecycleGeneration: dispatchLifecycleGeneration,
                  expectedSessionId: cleanupSessionId,
                  expectedLifecycleRevision: cleanupSessionLifecycleRevision,
                };
                recordAcceptedRunTermination(runId, terminationOwner);
                try {
                  const response = gatewayRuntime
                    ? await gatewayRuntime.dispatchAgent(
                        request.params as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
                        request.timeoutMs,
                        launch.authorization
                          ? { allowModelOverride: true, scopes: [ADMIN_SCOPE] }
                          : undefined,
                      )
                    : await deps().callGateway(request);
                  const gatewayRunId = readGatewayRunId(response) ?? runId;
                  if (!startQueuedSubagentRun(runId, gatewayRunId, terminationOwner)) {
                    throw new Error(
                      "collector registry row could not transition from queued to running",
                    );
                  }
                } catch (error) {
                  markAcceptedRunTerminationPending(runId, terminationOwner);
                  launchTerminationConfirmed = await terminateAcceptedRestoredCollectorRun({
                    entry,
                    ownerRunId: runId,
                    timeoutMs: launch.timeoutMs,
                  });
                  launchTerminationPending = !launchTerminationConfirmed;
                  throw error;
                }
              });
            },
            onStartFailure: (error) => {
              if (launchTerminationPending) {
                return "held";
              }
              if (launchTerminationConfirmed) {
                scheduleSweep({ delayMs: 0 });
                return true;
              }
              if (error instanceof GatewayDrainingError) {
                return false;
              }
              return failAndCleanupRestoredQueuedRun(
                runId,
                entry,
                error instanceof Error ? error.message : String(error),
                launchLifecycleGeneration ?? getAgentEventLifecycleGeneration(),
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
    lifecycleGeneration: string,
  ): Promise<SwarmStartFailureDisposition> {
    if (runs.get(runId) !== entry || entry.execution.status !== "queued") {
      return true;
    }
    try {
      if (
        !settleFailedQueuedSubagentLaunch(runId, error, {
          suppressSessionEffects: !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration),
        })
      ) {
        return "held";
      }
      // The FIFO owns execution ordering only. Durable launch cleanup remains
      // row-owned and retries independently after the terminal fact commits.
      scheduleSweep({ delayMs: 0 });
      return true;
    } catch (persistError) {
      warn("failed to persist restored collector launch failure", {
        runId,
        childSessionKey: entry.childSessionKey,
        error: persistError,
      });
      scheduleSweep({ delayMs: 0 });
      return "held";
    }
  }

  return {
    restoreOnce: restoreSubagentRunsOnce,
    reset: () => {
      clearRestoreRetryTimer();
      restoreState = "idle";
      restoredRowsPending = false;
    },
  };
}
