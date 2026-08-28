import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import type { callGateway } from "../../../gateway/call.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { runExclusiveSessionLifecycleMutation } from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import {
  finalizeTaskRunByRunId,
  findDetachedTaskRun,
} from "../../../tasks/detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "../../../tasks/task-cancellation-state.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { terminateAcceptedCollectorRun } from "../spawn/subagent-spawn-cleanup.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type {
  SubagentAcceptedSteerDispatch,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
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
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
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
  const childRuns = () => params.getRunsForChildSession(params.entry.childSessionKey);
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(
    childRuns(),
    params.entry.childSessionKey,
  );
  if (latest !== params.entry) {
    try {
      const taskResolution = resolveSubagentTaskForRun(childRuns(), params.entry);
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
        getLatestSubagentRunByChildSessionKeyFromRuns(childRuns(), params.entry.childSessionKey) ===
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
    getLatestSubagentRunByChildSessionKeyFromRuns(childRuns(), params.entry.childSessionKey) ===
      params.entry;
  const cfg = getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
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

export async function reconcileAcceptedSteerDispatch(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  callGateway: typeof callGateway;
  persistOrThrow: (runId: string) => void;
  clearSubagentRunSteerRestart: (
    runId: string,
    expected?: SubagentRunRecord,
    acceptedDispatch?: SubagentAcceptedSteerDispatch,
    requirePersistence?: boolean,
  ) => boolean;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const dispatch = params.entry.acceptedSteerDispatch;
  if (!dispatch) {
    return false;
  }
  if (
    params.runs.get(params.runId) !== params.entry ||
    params.entry.acceptedSteerDispatch !== dispatch
  ) {
    return true;
  }
  if (
    dispatch.phase === "dispatching" &&
    dispatch.lifecycleGeneration !== undefined &&
    isAgentEventLifecycleGenerationCurrent(dispatch.lifecycleGeneration)
  ) {
    return true;
  }
  try {
    // Retry the strict owner write before cleanup. Termination must not erase the
    // only in-memory receipt before restart can recover it.
    params.persistOrThrow(params.runId);
  } catch (error) {
    params.warn("failed to persist accepted steer dispatch during sweep", {
      error,
      runId: params.runId,
      gatewayRunId: dispatch.gatewayRunId,
    });
    return true;
  }

  const terminated = await terminateAcceptedCollectorRun({
    childSessionKey: params.entry.childSessionKey,
    gatewayRunId: dispatch.gatewayRunId,
    expectedSessionId: dispatch.expectedSessionId,
    expectedLifecycleRevision: dispatch.expectedLifecycleRevision,
    timeoutMs: 10_000,
    callGateway: params.callGateway,
    retry: false,
  });
  if (
    terminated &&
    params.runs.get(params.runId) === params.entry &&
    params.entry.acceptedSteerDispatch === dispatch
  ) {
    params.clearSubagentRunSteerRestart(params.runId, params.entry, dispatch);
  }
  return true;
}

export async function reconcileAcceptedSpawnRollback(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  callGateway: typeof callGateway;
  recordAcceptedSubagentSpawnRollback: (params: {
    runId: string;
    childSessionKey: string;
    gatewayRunId: string;
    reason: string;
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  }) =>
    | { status: "persisted" }
    | { status: "pending-persistence"; error: unknown }
    | { status: "rejected" };
  rollbackSubagentRunRegistration: (params: { runId: string; childSessionKey: string }) => boolean;
  settleFailedQueuedSubagentLaunch: (runId: string, error: string) => boolean;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const rollback = params.entry.acceptedSpawnRollback;
  if (!rollback || params.runs.get(params.runId) !== params.entry) {
    return false;
  }
  const record = params.recordAcceptedSubagentSpawnRollback({
    runId: params.runId,
    childSessionKey: params.entry.childSessionKey,
    gatewayRunId: rollback.gatewayRunId,
    reason: rollback.reason,
    expectedSessionId: rollback.expectedSessionId,
    expectedLifecycleRevision: rollback.expectedLifecycleRevision,
  });
  if (record.status === "pending-persistence") {
    params.warn("failed to persist accepted spawn rollback owner", {
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
      error: record.error,
    });
  }
  const terminated = await terminateAcceptedCollectorRun({
    childSessionKey: params.entry.childSessionKey,
    gatewayRunId: rollback.gatewayRunId,
    expectedSessionId: rollback.expectedSessionId,
    expectedLifecycleRevision: rollback.expectedLifecycleRevision,
    callGateway: params.callGateway,
    retry: false,
  });
  if (
    !terminated ||
    params.runs.get(params.runId) !== params.entry ||
    params.entry.acceptedSpawnRollback !== rollback
  ) {
    return true;
  }
  if (params.entry.collect) {
    params.settleFailedQueuedSubagentLaunch(params.runId, rollback.reason);
  } else {
    params.rollbackSubagentRunRegistration({
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
    });
  }
  return true;
}

export function selectNextAcceptedSteerCandidate<T extends { runId: string }>(
  candidates: readonly T[],
  previousRunId?: string,
): T | undefined {
  const previousIndex = candidates.findIndex((candidate) => candidate.runId === previousRunId);
  return candidates.length > 0 ? candidates[(previousIndex + 1) % candidates.length] : undefined;
}
