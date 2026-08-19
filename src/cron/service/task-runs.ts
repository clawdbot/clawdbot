/** Detached task-ledger integration for cron runs. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { CRON_TASK_KIND } from "../../tasks/cron-task-contract.js";
import {
  createRunningTaskRunCore,
  finalizeTaskRunById,
  finalizeTaskRunByRunIdCore,
  findTaskByRunId,
  recordTaskRunProgressByRunIdCore,
} from "../../tasks/task-executor.js";
import { listTaskRecordsByRuntimeSourceIdInDatabase } from "../../tasks/task-registry.store.sqlite.js";
import type { JsonValue, TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  resolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import { cronStoreKey } from "../store/key.js";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
  cronQuietTriggerTaskDetail,
  cronTaskRecordStoreKey,
  cronTaskRecordToRunLogEntry,
  cronTaskRecordToScriptRunResult,
  cronTaskRecordToTriggerEval,
  resolveCronTaskRecordTimestamp,
} from "../task-run-detail.js";
import { cronRunLogEntryFromEvent } from "../task-run-event-codec.js";
import type { CronJob, CronRunErrorClassification, CronRunStatus } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { CRON_TASK_RUNNING_PROGRESS_SUMMARY } from "./task-ledger.js";

function requireCronAgentId(agentId: string | undefined): string {
  if (!agentId?.trim()) {
    throw new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  }
  return normalizeAgentId(agentId);
}

function resolveCurrentDefaultAgentId(state: CronServiceState): string | undefined {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}

const activeCronTaskRunId = new AsyncLocalStorage<string>();

/** Keeps the detached task id on the async execution that owns it. */
export function withCronTaskRunId<T>(taskRunId: string | undefined, run: () => T): T {
  const normalizedRunId = taskRunId?.trim();
  return normalizedRunId ? activeCronTaskRunId.run(normalizedRunId, run) : run();
}

export function getActiveCronTaskRunId(): string | undefined {
  return activeCronTaskRunId.getStore();
}

/** Updates an active cron task with the exact transcript identity reported by its runner. */
export function tryUpdateCronTaskRunSession(
  state: CronServiceState,
  taskRunId: string | undefined,
  sessionKey: string | undefined,
): void {
  const childSessionKey = sessionKey?.trim();
  if (!taskRunId || !childSessionKey) {
    return;
  }
  try {
    const updated = recordTaskRunProgressByRunIdCore({
      runId: taskRunId,
      runtime: "cron",
      childSessionKey,
    });
    if (updated.length === 0) {
      state.deps.log.warn({ runId: taskRunId }, "cron: task ledger session was not updated");
    }
  } catch (error) {
    state.deps.log.warn({ runId: taskRunId, error }, "cron: failed to update task ledger session");
  }
}

/** Creates a best-effort detached task row keyed to the persisted execution start. */
export function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
  publicRunId?: string;
}): string | undefined {
  const runId = createCronTaskRunId(params.job.id, params.startedAt, params.publicRunId);
  return tryCreateCronTaskRunRecord({
    state: params.state,
    job: params.job,
    jobId: params.job.id,
    startedAt: params.startedAt,
    runId,
  });
}

function createCronTaskRunId(jobId: string, startedAt: number, publicRunId?: string): string {
  const discriminator = publicRunId?.trim() || randomUUID();
  return `${createCronExecutionId(jobId, startedAt)}:${discriminator}`;
}

function findLatestCronTaskRunForRecoveryFromRecords(
  records: readonly TaskRecord[],
  jobId: string,
  startedAt: number,
  storeKey: string,
): TaskRecord | undefined {
  const executionRunId = createCronExecutionId(jobId, startedAt);
  const prefix = `${executionRunId}:`;
  return records
    .filter((task) => {
      if (task.runtime !== "cron" || task.sourceId !== jobId) {
        return false;
      }
      const taskStoreKey = cronTaskRecordStoreKey(task);
      if (taskStoreKey === undefined) {
        // Exact match covers detail-less pre-discriminator rows from older releases.
        return task.runId === executionRunId;
      }
      return (
        taskStoreKey === storeKey &&
        (task.runId === executionRunId ||
          task.runId?.startsWith(prefix) ||
          // Released reservation-keyed rows still record the authoritative execution start.
          task.startedAt === startedAt)
      );
    })
    .toSorted(
      (left, right) =>
        Number(left.endedAt !== undefined) - Number(right.endedAt !== undefined) ||
        resolveCronTaskRecordTimestamp(right) - resolveCronTaskRecordTimestamp(left) ||
        right.createdAt - left.createdAt ||
        right.taskId.localeCompare(left.taskId),
    )[0];
}

type FinalizedCronTaskRun = {
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: JsonValue };
  triggerEval?: { fired: boolean; stateChanged: boolean; state?: JsonValue };
};

function finalizedCronTaskRun(
  task: TaskRecord | undefined,
  jobId: string,
): FinalizedCronTaskRun | undefined {
  if (task?.runtime !== "cron" || task.sourceId !== jobId || task.endedAt === undefined) {
    return undefined;
  }
  const triggerEval = cronTaskRecordToTriggerEval(task);
  const storedEntry = cronTaskRecordToRunLogEntry(task);
  const entry =
    storedEntry ??
    (task.status === "succeeded" && triggerEval?.fired === false
      ? {
          ts: task.endedAt,
          jobId,
          action: "finished" as const,
          status: "ok" as const,
          ...(task.startedAt === undefined
            ? {}
            : {
                runAtMs: task.startedAt,
                durationMs: Math.max(0, task.endedAt - task.startedAt),
              }),
        }
      : undefined);
  if (!entry?.status) {
    return undefined;
  }
  const scriptResult = cronTaskRecordToScriptRunResult(task);
  return {
    entry: { ...entry, status: entry.status },
    ...(scriptResult ? { scriptResult } : {}),
    ...(triggerEval ? { triggerEval } : {}),
  };
}

/** Re-reads task recovery facts on the caller's exact SQLite transaction. */
export function findCronTaskRunRecoveryInDatabase(params: {
  database: DatabaseSync;
  jobId: string;
  startedAt: number;
  storeKey: string;
}): { taskRunId?: string; finalized?: FinalizedCronTaskRun } {
  const task = findLatestCronTaskRunForRecoveryFromRecords(
    listTaskRecordsByRuntimeSourceIdInDatabase(params.database, "cron", params.jobId),
    params.jobId,
    params.startedAt,
    params.storeKey,
  );
  const finalized = finalizedCronTaskRun(task, params.jobId);
  return {
    ...(task?.runId ? { taskRunId: task.runId } : {}),
    ...(finalized ? { finalized } : {}),
  };
}

function tryCreateCronTaskRunRecord(params: {
  state: CronServiceState;
  job?: CronJob;
  jobId: string;
  startedAt: number;
  runId: string;
  childSessionKey?: string;
}): string | undefined {
  try {
    const childSessionKey = params.childSessionKey;
    const effectiveJobAgentId = params.job
      ? resolveCronJobEffectiveAgentId(params.job, resolveCurrentDefaultAgentId(params.state))
      : undefined;
    const task = createRunningTaskRunCore({
      runtime: "cron",
      taskKind: CRON_TASK_KIND,
      sourceId: params.jobId,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey,
      agentId:
        effectiveJobAgentId ??
        (childSessionKey
          ? resolveAgentIdFromSessionKey(
              childSessionKey,
              resolveCurrentDefaultAgentId(params.state),
            )
          : requireCronAgentId(resolveCurrentDefaultAgentId(params.state))),
      runId: params.runId,
      label: params.job?.name,
      task: params.job?.name || params.jobId,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
      progressSummary: CRON_TASK_RUNNING_PROGRESS_SUMMARY,
      detail: { storeKey: cronStoreKey(params.state.deps.storePath) },
    });
    if (!task) {
      params.state.deps.log.warn(
        { jobId: params.jobId },
        "cron: task ledger record was not persisted",
      );
      return undefined;
    }
    return params.runId;
  } catch (error) {
    params.state.deps.log.warn(
      { jobId: params.jobId, error },
      "cron: failed to create task ledger record",
    );
    return undefined;
  }
}

/** Finalizes executions that intentionally do not produce a run-history row. */
export function tryFinishCronTaskRunWithoutHistory(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    status: "ok" | "error" | "skipped";
    error?: unknown;
    endedAt: number;
    summary?: string;
    childSessionKey?: string;
    sessionKey?: string;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): void {
  if (!result.taskRunId) {
    return;
  }
  const error =
    result.status !== "ok" && result.error !== undefined
      ? normalizeCronRunErrorText(result.error)
      : undefined;
  const quietTriggerEval =
    result.triggerEval?.fired === false
      ? { ...result.triggerEval, fired: false as const }
      : undefined;
  try {
    finalizeTaskRunByRunIdCore({
      runId: result.taskRunId,
      runtime: "cron",
      status: cronRunStatusToTaskStatus({ status: result.status, error }),
      endedAt: result.endedAt,
      lastEventAt: result.endedAt,
      error,
      terminalSummary: result.summary,
      childSessionKey: result.childSessionKey ?? result.sessionKey ?? null,
      ...(quietTriggerEval
        ? {
            detail: cronQuietTriggerTaskDetail(
              cronStoreKey(state.deps.storePath),
              quietTriggerEval,
            ),
          }
        : {}),
    });
  } catch (cause) {
    state.deps.log.warn(
      { runId: result.taskRunId, jobStatus: result.status, error: cause },
      "cron: failed to update task ledger record",
    );
  }
}

/** Finalizes the authoritative task row, creating one for terminal-only cron events. */
export function tryFinishCronTaskRun(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    job?: CronJob;
    event: CronEvent & { action: "finished" };
    errorClassification?: CronRunErrorClassification;
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): void {
  const entry = cronRunLogEntryFromEvent(
    result.event,
    state.deps.nowMs(),
    result.errorClassification,
  );
  const startedAt = entry.runAtMs ?? entry.ts;
  const candidateRunId =
    result.taskRunId ?? createCronTaskRunId(entry.jobId, startedAt, entry.runId);
  try {
    const existingCandidate = findTaskByRunId(candidateRunId);
    const taskRunId =
      existingCandidate?.runtime === "cron"
        ? candidateRunId
        : tryCreateCronTaskRunRecord({
            state,
            job: result.job ?? result.event.job,
            jobId: entry.jobId,
            startedAt,
            runId: candidateRunId,
            childSessionKey: entry.sessionKey,
          });
    if (!taskRunId) {
      return;
    }
    const storeKey = cronStoreKey(state.deps.storePath);
    const legacyRecoveryRunId = createCronExecutionId(entry.jobId, startedAt);
    const detail = cronRunLogEntryToTaskDetail(entry, {
      storeKey,
      ...(result.scriptResult ? { scriptResult: result.scriptResult } : {}),
      ...(result.triggerEval ? { triggerEval: result.triggerEval } : {}),
    });
    const finalize = (
      runId: string,
      status: Extract<
        TaskStatus,
        "succeeded" | "failed" | "timed_out" | "cancelled"
      > = cronRunStatusToTaskStatus(entry),
    ) =>
      finalizeTaskRunByRunIdCore({
        runId,
        runtime: "cron",
        status,
        endedAt: entry.ts,
        lastEventAt: entry.ts,
        error: entry.error,
        clearError: entry.error === undefined,
        terminalSummary: entry.summary ?? null,
        preserveTerminalSummary: true,
        childSessionKey: entry.sessionKey ?? null,
        detail,
      });
    let updated = finalize(taskRunId);
    if (updated.length === 0) {
      const existing = findTaskByRunId(taskRunId);
      if (existing?.runtime === "cron" && existing.status === "cancelled") {
        // Operator cancellation owns task status, but its finished event still owns history detail.
        updated = finalize(taskRunId, "cancelled");
      } else if (
        existing?.runtime === "cron" &&
        (existing.status === "lost" ||
          (cronTaskRecordStoreKey(existing) === storeKey &&
            cronTaskRecordToRunLogEntry(existing) === null) ||
          (existing.detail === undefined && existing.runId === legacyRecoveryRunId))
      ) {
        // Pre-persist markers and exact legacy identities contain no history detail.
        // Startup recovery replaces them with the durable interrupted outcome.
        const recovered = finalizeTaskRunById({
          taskId: existing.taskId,
          status: cronRunStatusToTaskStatus(entry),
          childSessionKey: entry.sessionKey ?? null,
          endedAt: entry.ts,
          lastEventAt: entry.ts,
          error: entry.error,
          terminalSummary: entry.summary ?? null,
          preserveTerminalSummary: true,
          detail,
        });
        updated = recovered ? [recovered] : [];
      } else if (existing?.runtime === "cron") {
        // Keep the existing run/session scope when its first terminal write failed.
        updated = finalize(taskRunId);
      } else {
        // A terminal event still owns one durable row if its active mirror vanished.
        const recreatedRunId = tryCreateCronTaskRunRecord({
          state,
          job: result.job ?? result.event.job,
          jobId: entry.jobId,
          startedAt,
          runId: taskRunId,
          childSessionKey: entry.sessionKey,
        });
        if (recreatedRunId) {
          updated = finalize(recreatedRunId);
        }
      }
    }
    if (updated.length === 0) {
      state.deps.log.warn({ runId: taskRunId }, "cron: task ledger record was not finalized");
    }
  } catch (error) {
    state.deps.log.warn(
      { runId: candidateRunId, jobStatus: entry.status, error },
      "cron: failed to update task ledger record",
    );
  }
}
