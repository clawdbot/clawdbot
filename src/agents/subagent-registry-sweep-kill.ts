import { getRuntimeConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { finalizeTaskRunByRunId, findDetachedTaskRun } from "../tasks/detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "../tasks/task-cancellation-state.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

function findNextSubagentRunCreatedAt(
  candidates: Iterable<SubagentRunRecord>,
  entry: SubagentRunRecord,
): number | undefined {
  let nextCreatedAt = entry.killReconciliation?.supersededAt;
  for (const candidate of candidates) {
    if (
      candidate.runId === entry.runId ||
      candidate.childSessionKey !== entry.childSessionKey ||
      compareSubagentRunGeneration(candidate, entry) <= 0
    ) {
      continue;
    }
    nextCreatedAt = Math.min(nextCreatedAt ?? candidate.createdAt, candidate.createdAt);
  }
  return nextCreatedAt;
}

function resolveSubagentTaskForRunGeneration(
  entry: SubagentRunRecord,
  nextRunCreatedAt: number | undefined,
) {
  const generationStartedAt = entry.sessionStartedAt ?? entry.createdAt;
  return findDetachedTaskRun({
    runId: entry.taskRunId ?? entry.runId,
    runtime: "subagent",
    sessionKey: entry.childSessionKey,
    createdAtOrAfter: generationStartedAt,
    createdBefore: nextRunCreatedAt,
    // Steer/wake replaces the registry run ID while retaining the original
    // task row. Only those continuations may adopt a session-scoped task.
    allowSessionFallback:
      entry.taskRunId === undefined &&
      typeof entry.sessionStartedAt === "number" &&
      entry.sessionStartedAt < entry.createdAt,
  });
}

function isStableCancellation(task: TaskRecord | undefined) {
  return task?.status === "cancelled" && !isProvisionalSubagentKillTask(task);
}

function isUnstableTask(task: TaskRecord | undefined) {
  return (
    task !== undefined &&
    (task.status === "queued" || task.status === "running" || isProvisionalSubagentKillTask(task))
  );
}

export function resolveSubagentTaskForRun(
  candidates: Iterable<SubagentRunRecord>,
  entry: SubagentRunRecord,
) {
  return resolveSubagentTaskForRunGeneration(
    entry,
    findNextSubagentRunCreatedAt(candidates, entry),
  );
}

export async function reconcileDurableSubagentKillIntent(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  loadKillRuntime: () => Promise<typeof import("./subagent-control.runtime.js")>;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const killIntent = params.entry.killIntent;
  if (!killIntent) {
    return false;
  }
  if (params.runs.get(params.runId) !== params.entry) {
    return false;
  }
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(
    params.runs,
    params.entry.childSessionKey,
  );
  if (latest !== params.entry) {
    try {
      const taskResolution = resolveSubagentTaskForRun(params.runs.values(), params.entry);
      const task = taskResolution.task;
      if (taskResolution.lookup === "unavailable" || isUnstableTask(task)) {
        const finalized = finalizeTaskRunByRunId({
          runId: task?.runId ?? params.entry.taskRunId ?? params.runId,
          runtime: "subagent",
          sessionKey: task?.childSessionKey ?? params.entry.childSessionKey,
          status: "cancelled",
          endedAt: killIntent.requestedAt,
          lastEventAt: killIntent.requestedAt,
          error: "Superseded subagent cancellation finalized.",
          suppressDelivery: true,
        });
        if (taskResolution.lookup === "available" && finalized.length === 0) {
          params.warn("could not stabilize superseded durable kill task", {
            runId: params.runId,
            childSessionKey: params.entry.childSessionKey,
          });
          return false;
        }
      }
      if (
        params.runs.get(params.runId) !== params.entry ||
        getLatestSubagentRunByChildSessionKeyFromRuns(params.runs, params.entry.childSessionKey) ===
          params.entry
      ) {
        return false;
      }
      await params.retireSupersededRun(params.runId, params.entry);
      return true;
    } catch (error) {
      params.warn("failed to retire superseded durable kill intent", {
        error,
        runId: params.runId,
        childSessionKey: params.entry.childSessionKey,
      });
      return false;
    }
  }
  const ownsCurrentGeneration = () =>
    params.runs.get(params.runId) === params.entry &&
    params.entry.killIntent === killIntent &&
    killIntent.lifecycleGeneration !== undefined &&
    isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration) &&
    getLatestSubagentRunByChildSessionKeyFromRuns(params.runs, params.entry.childSessionKey) ===
      params.entry;
  const cfg = getRuntimeConfig();
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: resolveAgentIdFromSessionKey(params.entry.childSessionKey),
  });
  const ownsSessionIncarnation = () => {
    const current = loadSubagentSessionEntry({
      childSessionKey: params.entry.childSessionKey,
      cfg,
    });
    return (
      current?.sessionId === killIntent.sessionId &&
      current?.lifecycleRevision === killIntent.sessionLifecycleRevision
    );
  };
  const completeRetiredKill = async () => {
    await params.completeSubagentRunWithRecovery(
      {
        runId: params.runId,
        expectedEntry: params.entry,
        endedAt: killIntent.requestedAt,
        outcome: { status: "error", error: killIntent.reason },
        reason: SUBAGENT_ENDED_REASON_KILLED,
        sendFarewell: true,
        accountId: params.entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        suppressSessionEffects: true,
      },
      "sweeper-retired-kill-intent",
    );
    return true;
  };
  if (
    killIntent.lifecycleGeneration === undefined ||
    !isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration)
  ) {
    return await completeRetiredKill();
  }
  try {
    const runtime = await params.loadKillRuntime();
    if (!ownsCurrentGeneration()) {
      return false;
    }
    if (!ownsSessionIncarnation()) {
      return await completeRetiredKill();
    }
    return await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [params.entry.childSessionKey, killIntent.sessionId],
      run: async () => {
        if (!ownsCurrentGeneration()) {
          return false;
        }
        if (!ownsSessionIncarnation()) {
          return await completeRetiredKill();
        }
        const hasLiveRunContext = Boolean(getAgentRunContext(params.runId));
        const active = killIntent.sessionId
          ? runtime.isEmbeddedAgentRunActive(killIntent.sessionId)
          : false;
        const aborted =
          killIntent.sessionId && active
            ? runtime.abortEmbeddedAgentRun(killIntent.sessionId)
            : false;
        if (!ownsSessionIncarnation()) {
          return await completeRetiredKill();
        }
        runtime.clearSessionQueues([params.entry.childSessionKey, killIntent.sessionId]);
        if ((active || hasLiveRunContext) && !aborted) {
          return false;
        }
        if (!ownsCurrentGeneration()) {
          return false;
        }
        if (!ownsSessionIncarnation()) {
          return await completeRetiredKill();
        }
        await params.completeSubagentRunWithRecovery(
          {
            runId: params.runId,
            expectedEntry: params.entry,
            endedAt: killIntent.requestedAt,
            outcome: { status: "error", error: killIntent.reason },
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: params.entry.requesterOrigin?.accountId,
            triggerCleanup: true,
          },
          "sweeper-pending-kill-intent",
        );
        return true;
      },
    });
  } catch (error) {
    params.warn("failed to finish durable subagent kill intent", {
      error,
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
    });
    return false;
  }
}

function resolveCompletionFromTerminalTask(task: TaskRecord | undefined, entry: SubagentRunRecord) {
  if (
    !task ||
    typeof task.endedAt !== "number" ||
    (task.status !== "succeeded" && task.status !== "failed" && task.status !== "timed_out")
  ) {
    return undefined;
  }
  const outcome: SubagentCompletionRequest["outcome"] =
    task.status === "succeeded"
      ? { status: "ok" }
      : task.status === "timed_out"
        ? { status: "timeout" }
        : { status: "error", error: task.error };
  return {
    startedAt: entry.execution.startedAt ?? task.startedAt,
    endedAt: task.endedAt,
    outcome,
    reason: task.status === "failed" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
    completionSnapshot: {
      resultText: task.progressSummary ?? task.terminalSummary ?? null,
      capturedAt: task.endedAt,
    },
  };
}

export async function reconcileProvisionalSubagentKill(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  runs: Map<string, SubagentRunRecord>;
  storeCache: SubagentSessionStoreCache;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  startSubagentAnnounceCleanupFlow: (runId: string, entry: SubagentRunRecord) => boolean;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const { entry, now, runId, runs } = params;
  const killReconciliation = entry.killReconciliation;
  if (!killReconciliation) {
    return false;
  }
  // The child-session index stays current across awaits. Re-read it at each
  // decision boundary so a newly registered generation can supersede this run.
  const resolveGeneration = () => {
    const nextRunCreatedAt = findNextSubagentRunCreatedAt(
      params.getRunsForChildSession(entry.childSessionKey),
      entry,
    );
    return {
      nextRunCreatedAt,
      taskResolution: resolveSubagentTaskForRunGeneration(entry, nextRunCreatedAt),
    };
  };
  const initialGeneration = resolveGeneration();
  const taskResolution = initialGeneration.taskResolution;
  const task = taskResolution.task;
  const nextRunCreatedAt = initialGeneration.nextRunCreatedAt;
  const hasStableTaskCancellation = isStableCancellation(task);
  const killedAt = killReconciliation.killedAt;
  const isCurrentKill = () =>
    runs.get(runId) === entry &&
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.killReconciliation === killReconciliation;
  const taskCompletion =
    nextRunCreatedAt === undefined ? resolveCompletionFromTerminalTask(task, entry) : undefined;
  if (taskCompletion) {
    // Replay the durable task projection before a provisional kill can age
    // into a contradictory cancellation after an interrupted registry write.
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        ...taskCompletion,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      },
      "sweeper-provisional-kill-task-completion",
    );
    return false;
  }
  if (killedAt + PROVISIONAL_KILL_RECONCILIATION_MS > now) {
    return false;
  }
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: entry.childSessionKey,
    storeCache: params.storeCache,
  });
  const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
  });
  const completionEndedAt = completion
    ? resolveSubagentRunEffectiveEndedAt(entry, completion.endedAt, completion.startedAt)
    : undefined;
  const completionDeadline = completion
    ? resolveSubagentRunDeadlineMs(entry, completion.startedAt)
    : undefined;
  const killedSnapshotExpiredDeadline =
    completion?.reason === SUBAGENT_ENDED_REASON_KILLED &&
    completionDeadline !== undefined &&
    completion.endedAt > completionDeadline
      ? completionDeadline
      : undefined;
  const completionCanOverrideCancellation =
    !hasStableTaskCancellation || (completionEndedAt ?? Number.POSITIVE_INFINITY) < killedAt;
  const completionBelongsToGeneration =
    nextRunCreatedAt === undefined || (completion != null && completion.endedAt < nextRunCreatedAt);
  if (
    completion &&
    completionEndedAt !== undefined &&
    completionCanOverrideCancellation &&
    completionBelongsToGeneration &&
    (completion.reason !== SUBAGENT_ENDED_REASON_KILLED ||
      killedSnapshotExpiredDeadline !== undefined)
  ) {
    const hasNewerGeneration = nextRunCreatedAt !== undefined;
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        startedAt: completion.startedAt,
        endedAt: killedSnapshotExpiredDeadline ?? completion.endedAt,
        outcome:
          killedSnapshotExpiredDeadline !== undefined ? { status: "timeout" } : completion.outcome,
        reason:
          killedSnapshotExpiredDeadline !== undefined
            ? SUBAGENT_ENDED_REASON_COMPLETE
            : completion.reason,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: !hasNewerGeneration,
        suppressSessionEffects: hasNewerGeneration,
      },
      "sweeper-provisional-kill-completion",
    );
    if (
      hasNewerGeneration &&
      runs.get(runId) === entry &&
      entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED
    ) {
      await params.retireSupersededRun(runId, entry);
      return true;
    }
    if (!isCurrentKill()) {
      return false;
    }
    const taskAfterResolution = resolveGeneration().taskResolution;
    const taskAfter = taskAfterResolution.task;
    const stableCancellationWonDuringCompletion =
      isStableCancellation(taskAfter) && completionEndedAt >= killedAt;
    if (!stableCancellationWonDuringCompletion && taskAfterResolution.lookup !== "unavailable") {
      return false;
    }
  }
  if (!isCurrentKill()) {
    return false;
  }
  const taskBeforeResolution = resolveGeneration().taskResolution;
  const taskBefore = taskBeforeResolution.task;
  const stableTaskCancellationAfterReconciliation = isStableCancellation(taskBefore);
  const taskNeedsStabilization =
    taskBeforeResolution.lookup === "unavailable" || isUnstableTask(taskBefore);
  if (taskNeedsStabilization) {
    const observedError =
      entry.execution.outcome?.status === "error"
        ? entry.execution.outcome.error?.trim()
        : undefined;
    try {
      const finalizedTasks = finalizeTaskRunByRunId({
        runId: taskBefore?.runId ?? entry.taskRunId ?? runId,
        runtime: "subagent",
        sessionKey: taskBefore?.childSessionKey ?? entry.childSessionKey,
        status: "cancelled",
        endedAt: killedAt,
        lastEventAt: killedAt,
        error:
          observedError && observedError !== SUBAGENT_KILL_TASK_ERROR
            ? observedError
            : "Subagent run cancellation finalized.",
        suppressDelivery: true,
      });
      if (finalizedTasks.length === 0) {
        const taskAfterResolution = resolveGeneration().taskResolution;
        const taskAfter = taskAfterResolution.task;
        if (taskAfterResolution.lookup === "available" && isUnstableTask(taskAfter)) {
          params.warn("killed task was not stabilized during sweep", {
            runId,
            childSessionKey: entry.childSessionKey,
          });
          return false;
        }
        if (taskAfterResolution.lookup === "unavailable") {
          params.warn("retiring killed tombstone after opaque task finalization", {
            runId,
            childSessionKey: entry.childSessionKey,
          });
        }
      }
    } catch (error) {
      params.warn("failed to finalize provisional killed task during sweep", {
        error,
        runId,
        childSessionKey: entry.childSessionKey,
      });
      return false;
    }
  }
  if (resolveGeneration().nextRunCreatedAt !== undefined) {
    await params.retireSupersededRun(runId, entry);
    return true;
  }
  entry.suppressCompletionDelivery =
    killReconciliation.suppressTaskDelivery === true ||
    hasStableTaskCancellation ||
    stableTaskCancellationAfterReconciliation
      ? true
      : undefined;
  entry.suppressAnnounceReason = undefined;
  entry.killReconciliation = undefined;
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  params.startSubagentAnnounceCleanupFlow(runId, entry);
  return true;
}
