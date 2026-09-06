/**
 * Subagent run manager.
 *
 * Waits for child runs, records terminal outcomes, creates task-runtime entries, and archives completed sessions.
 */
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { finalizeTaskRunByRunId } from "../../../tasks/detached-task-runtime.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { isSwarmRunActive, removeQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import {
  persistSubagentSessionTiming,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type { RegisterSubagentRunParams } from "./subagent-registry-run-launch.js";
export { markSubagentRunPausedAfterYield } from "./subagent-registry-run-wait.js";

const log = createSubsystemLogger("agents/subagent-registry");

class SubagentRunManager extends SubagentLaunchManager {
  readonly releaseSubagentRun = (runId: string): void => {
    const entry = this.options.runs.get(runId);
    if (!entry) {
      return;
    }
    this.options.runs.delete(runId);
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      this.options.runs.set(runId, entry);
      throw error;
    }
    this.options.clearPendingLifecycleError(runId);
    clearGatewayContextResolver(entry);
    if (this.shouldDeleteAttachments(entry)) {
      void safeRemoveAttachmentsDir(entry);
    }
    const releasedSessionStillUnowned = () =>
      !Array.from(this.options.getRunsForChildSession(entry.childSessionKey)).some(
        (candidate) => candidate !== entry,
      );
    void this.options.notifyContextEngineSubagentEnded(
      {
        childSessionKey: entry.childSessionKey,
        reason: "released",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      },
      { isCurrent: releasedSessionStillUnowned },
    );
    if (this.options.runs.size === 0) {
      this.options.stopSweeper();
    }
  };

  readonly claimSubagentRunKill = (claimParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId?: string;
    sessionLifecycleRevision?: string;
    suppressTaskDelivery?: boolean;
  }): SubagentRunRecord["killIntent"] => {
    const runId = claimParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      entry !== claimParams.expected ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      (typeof entry.execution.endedAt === "number" && entry.pauseReason !== "sessions_yield")
    ) {
      return undefined;
    }
    const claim = {
      requestedAt: Date.now(),
      reason: "killed",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId: claimParams.sessionId?.trim() || undefined,
      sessionLifecycleRevision: claimParams.sessionLifecycleRevision?.trim() || undefined,
      suppressTaskDelivery: claimParams.suppressTaskDelivery === true ? true : undefined,
    };
    entry.killIntent = claim;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.killIntent = undefined;
      throw error;
    }
    return claim;
  };

  readonly releaseSubagentRunKillClaim = (releaseParams: {
    runId: string;
    expected: SubagentRunRecord;
    claim: NonNullable<SubagentRunRecord["killIntent"]>;
  }): boolean => {
    const runId = releaseParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (!runId || entry !== releaseParams.expected || entry.killIntent !== releaseParams.claim) {
      return false;
    }
    entry.killIntent = undefined;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.killIntent = releaseParams.claim;
      throw error;
    }
    return true;
  };

  readonly markSubagentRunTerminated = (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
    suppressTaskDelivery?: boolean;
  }): number => {
    const runIds = new Set<string>();
    if (typeof markParams.runId === "string" && markParams.runId.trim()) {
      runIds.add(markParams.runId.trim());
    }
    const childSessionKey = markParams.childSessionKey?.trim();
    if (childSessionKey) {
      for (const entry of this.options.getRunsForChildSession(childSessionKey)) {
        runIds.add(entry.runId);
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const now = Date.now();
    const reason = markParams.reason?.trim() || "killed";
    let updated = 0;
    const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
    const queuedCollectorRunIds: string[] = [];
    const entrySnapshots = new Map<SubagentRunRecord, SubagentRunRecord>();
    const pendingTaskFinalizations: Array<{ entry: SubagentRunRecord; endedAt: number }> = [];
    const finalizeKilledTask = (entry: SubagentRunRecord, endedAt: number) => {
      const taskResolution = this.options.resolveSubagentTask(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const targetRunId = task?.runId ?? entry.taskRunId ?? entry.runId;
      const targetSessionKey = task?.childSessionKey ?? entry.childSessionKey;
      try {
        finalizeTaskRunByRunId({
          runId: targetRunId,
          runtime: "subagent",
          sessionKey: targetSessionKey,
          status: "cancelled",
          endedAt,
          lastEventAt: endedAt,
          error: SUBAGENT_KILL_TASK_ERROR,
          suppressDelivery: entry.killReconciliation?.suppressTaskDelivery === true,
        });
      } catch (err) {
        log.warn("failed to finalize killed subagent task run", {
          err,
          runId: targetRunId,
          childSessionKey: targetSessionKey,
        });
      }
    };
    for (const runId of runIds) {
      this.options.clearPendingLifecycleError(runId);
      this.options.clearPendingLifecycleTimeout(runId);
      const entry = this.options.runs.get(runId);
      if (!entry) {
        continue;
      }
      const wasKilledLifecycle =
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.killReconciliation !== undefined;
      const existingKillReconciliation = entry.killReconciliation;
      const existingKillIntent = entry.killIntent;
      const currentKillLifecycle =
        existingKillIntent?.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(existingKillIntent.lifecycleGeneration);
      if (
        typeof entry.execution.endedAt === "number" &&
        entry.pauseReason !== "sessions_yield" &&
        !wasKilledLifecycle
      ) {
        // An abort lifecycle event can mark the run killed before this shared
        // termination path runs. Re-enter only for that provisional state so
        // it receives the same reconciliation tombstone as a direct kill.
        continue;
      }
      // Rollback must retain the exact claim owned by the pending cancellation.
      entrySnapshots.set(entry, { ...structuredClone(entry), killIntent: entry.killIntent });
      const wasYielded = entry.pauseReason === "sessions_yield";
      const wasQueuedCollector = entry.collect && entry.execution.status === "queued";
      const collectorLaunchInFlight =
        wasQueuedCollector &&
        entry.swarmLaunchPending === true &&
        isSwarmRunActive(entry.schedulerSlotId ?? entry.runId);
      if (wasQueuedCollector) {
        queuedCollectorRunIds.push(entry.runId);
      }
      const endedAt =
        (wasYielded || wasKilledLifecycle) && typeof entry.execution.endedAt === "number"
          ? entry.execution.endedAt
          : now;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt,
        lifecycleGeneration:
          existingKillIntent && currentKillLifecycle
            ? existingKillIntent.lifecycleGeneration
            : entry.execution.lifecycleGeneration,
        restartRecovery: undefined,
        suppressSessionEffects:
          existingKillIntent && currentKillLifecycle
            ? undefined
            : entry.execution.suppressSessionEffects,
        outcome: withSubagentOutcomeTiming(
          { status: "error", error: reason },
          {
            startedAt: entry.execution.startedAt,
            endedAt,
          },
        ),
      };
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = existingKillReconciliation
        ? (entry.cleanupCompletedAt ?? endedAt)
        : wasKilledLifecycle
          ? endedAt
          : now;
      entry.suppressAnnounceReason = "killed";
      entry.pauseReason = undefined;
      entry.killIntent = undefined;
      // Terminalizing execution above short-circuits the completion watcher, so the
      // lifecycle finalizer never reaches the detached task row for killed runs.
      const taskEndedAt = existingKillIntent
        ? existingKillIntent.requestedAt
        : existingKillReconciliation
          ? (resolveKilledSubagentTaskEndedAt(entry) ?? endedAt)
          : wasYielded
            ? now
            : endedAt;
      entry.killReconciliation = {
        killedAt:
          existingKillIntent?.requestedAt ?? existingKillReconciliation?.killedAt ?? taskEndedAt,
        taskCancellationAccepted:
          existingKillIntent || existingKillReconciliation?.taskCancellationAccepted === true
            ? true
            : undefined,
        suppressTaskDelivery:
          existingKillIntent?.suppressTaskDelivery === true ||
          existingKillReconciliation?.suppressTaskDelivery === true ||
          markParams.suppressTaskDelivery === true
            ? true
            : undefined,
        supersededAt: existingKillReconciliation?.supersededAt,
      };
      if (wasQueuedCollector && !collectorLaunchInFlight) {
        updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
      } else if (!entry.collect) {
        updateSubagentArchiveAtMs(entry, this.options.getRuntimeConfig());
      }
      pendingTaskFinalizations.push({ entry, endedAt: taskEndedAt });
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      updated += 1;
    }
    if (updated > 0) {
      try {
        // The registry tombstone is the recovery source for the provisional
        // task marker. It must commit first so the sweeper can always finish it.
        this.options.persistOrThrow(...[...entrySnapshots.keys()].map((entry) => entry.runId));
      } catch (error) {
        for (const [entry, snapshot] of entrySnapshots) {
          this.restoreRunRecord(entry, snapshot);
        }
        throw error;
      }
      for (const pending of pendingTaskFinalizations) {
        finalizeKilledTask(pending.entry, pending.endedAt);
      }
      for (const runId of queuedCollectorRunIds) {
        const entry = this.options.runs.get(runId);
        removeQueuedSwarmRun(entry?.schedulerSlotId ?? runId);
      }
      for (const entry of entriesByChildSessionKey.values()) {
        // Task finalization removes the suspension blocker before these session-owned
        // writes finish. Join them under one independent root so snapshots stay atomic.
        void runWithGatewayIndependentRootWorkAdmission(async () => {
          await Promise.all([
            persistSubagentSessionTiming(entry, {
              isCurrentGeneration: () =>
                this.currentRunOwnsSession(entry) &&
                !shouldSuppressSubagentRecoverySessionEffects(entry),
              assertCommitAllowed: () => {
                if (
                  !this.currentRunOwnsSession(entry) ||
                  shouldSuppressSubagentRecoverySessionEffects(entry)
                ) {
                  throw new Error("killed subagent session owner retired before timing commit");
                }
              },
            }).catch((err: unknown) => {
              log.warn("failed to persist killed subagent session timing", {
                err,
                runId: entry.runId,
                childSessionKey: entry.childSessionKey,
              });
            }),
            this.shouldDeleteAttachments(entry)
              ? safeRemoveAttachmentsDir(entry)
              : Promise.resolve(),
          ]);
        }, "subagents:session-finalize").catch((err: unknown) => {
          log.warn("failed to run killed subagent cleanup tail", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        this.options.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          // A direct kill is provisional until the runner reports its final
          // outcome. Keep delete-mode rows as reconciliation tombstones.
          cleanup: "keep",
          completedAt: now,
          preserveTranscript: true,
          provisionalKill: true,
        });
      }
    }
    return updated;
  };
}

export function createSubagentRunManager(params: SubagentManagerOptions) {
  return new SubagentRunManager(params);
}
