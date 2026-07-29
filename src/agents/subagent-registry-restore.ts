import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
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
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { enqueueSwarmRun } from "./swarm-scheduler.js";

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  deps: () => SubagentRegistryDeps;
  persist: () => void;
  settleRequesterTurn: ReturnType<
    typeof createSubagentRegistryLifecycleController
  >["settleRequesterTurnAfterSessionSpawns"];
  ensureListener: () => void;
  startSweeper: () => void;
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: (groupId: string, requesterSessionKey?: string) => SubagentRunRecord[];
  startQueuedSubagentRun: (runId: string, gatewayRunId?: string) => boolean;
  terminateAcceptedRestoredCollectorRun: (params: {
    entry: SubagentRunRecord;
    gatewayRunId: string;
    timeoutMs: number;
  }) => Promise<void>;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  settleFailedQueuedSubagentLaunch: (runId: string, error: string) => void;
  completeCollectorLaunchCleanup: (runId: string) => void;
  scheduleOrphanRecovery: (params?: { delayMs?: number; maxRetries?: number }) => void;
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
    terminateAcceptedRestoredCollectorRun,
    cleanupCollectorLaunchResources,
    settleFailedQueuedSubagentLaunch,
    completeCollectorLaunchCleanup,
    scheduleOrphanRecovery,
    warn,
  } = config;
  let restoreAttempted = false;
  const readGatewayRunId = (response: unknown): string | undefined => {
    if (!response || typeof response !== "object") {
      return undefined;
    }
    const runId = (response as { runId?: unknown }).runId;
    return typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
  };

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
              runId: entry.runId,
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
        if (entry.collect && entry.execution?.status === "queued") {
          const launch = entry.queuedLaunch;
          if (!launch) {
            void failAndCleanupRestoredQueuedRun(
              runId,
              entry,
              "queued collector launch state was unavailable after restart",
              false,
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
          enqueueSwarmRun({
            groupId: launch.schedulerGroupKey,
            runId,
            maxConcurrent: currentSwarmConfig.maxConcurrent,
            activeRunIds: groupRuns
              .filter((candidate) => candidate.execution?.status === "running")
              .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
            start: async () => {
              await runWithGatewayIndependentRootWorkAdmission(async () => {
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
                  if (!startQueuedSubagentRun(runId, gatewayRunId)) {
                    throw new Error(
                      "collector registry row could not transition from queued to running",
                    );
                  }
                } catch (error) {
                  await terminateAcceptedRestoredCollectorRun({
                    entry,
                    gatewayRunId,
                    timeoutMs: launch.timeoutMs,
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
      scheduleOrphanRecovery();
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
  ): Promise<boolean> {
    const cleanupComplete = await runWithGatewayIndependentRootWorkAdmission(async () => {
      for (;;) {
        try {
          await deps().callGateway({
            method: "sessions.delete",
            params: {
              key: entry.childSessionKey,
              deleteTranscript: true,
              emitLifecycleHooks: false,
            },
            timeoutMs: 10_000,
          });
          break;
        } catch (cleanupError) {
          warn("failed to delete restored collector session after launch failure", {
            runId,
            childSessionKey: entry.childSessionKey,
            error: cleanupError,
          });
          if (launchTerminationConfirmed) {
            return false;
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
          timer.unref?.();
        });
      }
      if (!(await cleanupCollectorLaunchResources(entry))) {
        return false;
      }
      return true;
    }).catch((cleanupError: unknown) => {
      warn("failed to clean restored collector after launch failure", {
        runId,
        childSessionKey: entry.childSessionKey,
        error: cleanupError,
      });
      return false;
    });
    for (;;) {
      try {
        settleFailedQueuedSubagentLaunch(runId, error);
        break;
      } catch (persistError) {
        warn("failed to persist restored collector launch failure", {
          runId,
          childSessionKey: entry.childSessionKey,
          error: persistError,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
        timer.unref?.();
      });
    }
    if (cleanupComplete) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "delete",
        parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
      });
      completeCollectorLaunchCleanup(runId);
    }
    return true;
  }

  return {
    restoreOnce: restoreSubagentRunsOnce,
    reset: () => {
      restoreAttempted = false;
    },
  };
}
