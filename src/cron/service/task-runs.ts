/** Detached task-ledger integration for cron runs. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createExecutionStartedOwnerBinding,
  isRetainedExecutionOwnerBinding,
} from "../../audit/execution-owner-binding.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { CRON_TASK_KIND } from "../../tasks/cron-task-contract.js";
import {
  createRunningTaskRunCore,
  finalizeTaskRunById,
  finalizeTaskRunByRunIdCore,
  findTaskByRunId,
  recordTaskRunProgressByRunIdCore,
} from "../../tasks/task-executor.js";
import { bindTaskFlowExecution } from "../../tasks/task-flow-registry.store.sqlite.js";
import {
  bindTaskRunExecution,
  listTaskRecordsByRuntimeSourceIdInDatabase,
} from "../../tasks/task-registry.store.sqlite.js";
import type { JsonValue, TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  resolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import { cronStoreKey } from "../store/key.js";
import {
  bindCronRunReceiptExecution,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
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
import type {
  CronCompletionStatus,
  CronJob,
  CronRunErrorClassification,
  CronRunStatus,
} from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import type { CronEvent, CronExecutionIdentityAdmission, CronServiceState } from "./state.js";
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

/** Carries exact admission into the first post-admission owner lifecycle phase. */
export function createCronOwnerExecutionIdentityAdmission(params: {
  state: CronServiceState;
  runReceipt: CronRunReceiptHandle;
  taskId?: string;
  flowId?: string;
}): CronExecutionIdentityAdmission {
  const ownerBinding = createExecutionStartedOwnerBinding((admitted) => {
    try {
      const receiptResult = bindCronRunReceiptExecution({
        admitted,
        handle: params.runReceipt,
      });
      const taskResult = params.taskId
        ? isRetainedExecutionOwnerBinding(receiptResult)
          ? bindTaskRunExecution({ admitted, taskId: params.taskId })
          : receiptResult
        : undefined;
      const flowParentResult = params.taskId ? taskResult : receiptResult;
      const flowResult = params.flowId
        ? isRetainedExecutionOwnerBinding(receiptResult) &&
          isRetainedExecutionOwnerBinding(flowParentResult)
          ? bindTaskFlowExecution({ admitted, flowId: params.flowId })
          : flowParentResult
        : undefined;
      if (
        [receiptResult, taskResult, flowResult].some(
          (result) => result === "mismatch" || result === "missing",
        )
      ) {
        params.state.deps.log.warn(
          { receiptResult, taskResult, flowResult },
          "cron: exact execution identity binding was not retained",
        );
      }
    } catch (error) {
      params.state.deps.log.warn(
        { error },
        "cron: failed to retain exact execution identity binding",
      );
    }
  });
  return {
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    onPostAdmission: ownerBinding.onPostAdmission,
    onExecutionStarted: ownerBinding.onExecutionStarted,
  };
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

export function tryCreateCronTaskRunHandle(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
  runReceipt?: CronRunReceiptHandle;
  publicRunId?: string;
}): { runId: string; taskId?: string; flowId?: string } {
  const runId = createCronTaskRunId(
    params.job.id,
    params.startedAt,
    params.runReceipt?.receiptId,
    params.publicRunId,
  );
  return (
    tryCreateCronTaskRunRecord({
      state: params.state,
      job: params.job,
      jobId: params.job.id,
      startedAt: params.startedAt,
      runId,
    }) ?? { runId }
  );
}

function createCronTaskRunId(
  jobId: string,
  startedAt: number,
  receiptId?: string,
  publicRunId?: string,
): string {
  const receipt = receiptId?.trim();
  const publicId = publicRunId?.trim();
  const discriminator = receipt || publicId || randomUUID();
  const publicSuffix = publicId && publicId !== discriminator ? `:${publicId}` : "";
  return `${createCronExecutionId(jobId, startedAt)}:${discriminator}${publicSuffix}`;
}

function findLatestCronTaskRunForRecoveryFromRecords(
  records: readonly TaskRecord[],
  jobId: string,
  startedAt: number,
  storeKey: string,
  receiptId?: string,
): TaskRecord | undefined {
  const executionRunId = createCronExecutionId(jobId, startedAt);
  const prefix = `${executionRunId}:`;
  const receiptRunId = receiptId ? `${prefix}${receiptId}` : undefined;
  return records
    .filter((task) => {
      if (task.runtime !== "cron" || task.sourceId !== jobId) {
        return false;
      }
      const taskStoreKey = cronTaskRecordStoreKey(task);
      if (receiptRunId) {
        // Receipt recovery accepts only its owner-native identity; legacy rows
        // without that receipt prefix are ambiguous when runs share a millisecond.
        return (
          taskStoreKey === storeKey &&
          (task.runId === receiptRunId || task.runId?.startsWith(`${receiptRunId}:`))
        );
      }
      if (taskStoreKey === undefined) {
        // Exact match covers detail-less pre-discriminator rows from older releases.
        return task.runId === executionRunId;
      }
      // A matching timestamp cannot authorize adopting an unrelated task row.
      return (
        taskStoreKey === storeKey &&
        (task.runId === executionRunId || task.runId?.startsWith(prefix))
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
  receiptId?: string;
}): { taskRunId?: string; finalized?: FinalizedCronTaskRun } {
  const task = findLatestCronTaskRunForRecoveryFromRecords(
    listTaskRecordsByRuntimeSourceIdInDatabase(params.database, "cron", params.jobId),
    params.jobId,
    params.startedAt,
    params.storeKey,
    params.receiptId,
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
}): { runId: string; taskId: string; flowId?: string } | undefined {
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
    return {
      runId: params.runId,
      taskId: task.taskId,
      ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    };
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
    completionStatus?: CronCompletionStatus;
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
      status: cronRunStatusToTaskStatus({
        status: result.status,
        completionStatus: quietTriggerEval ? "succeeded" : result.completionStatus,
        error,
      }),
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
    const created =
      existingCandidate?.runtime === "cron"
        ? undefined
        : tryCreateCronTaskRunRecord({
            state,
            job: result.job ?? result.event.job,
            jobId: entry.jobId,
            startedAt,
            runId: candidateRunId,
            childSessionKey: entry.sessionKey,
          });
    const taskRunId = existingCandidate?.runtime === "cron" ? candidateRunId : created?.runId;
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
        ...(status === "cancelled"
          ? {}
          : {
              error: entry.error,
              clearError: entry.error === undefined,
              terminalSummary: entry.summary ?? null,
              preserveTerminalSummary: true,
            }),
        childSessionKey: entry.sessionKey ?? null,
        detail,
      });
    let updated = finalize(taskRunId);
    if (updated.length === 0) {
      const existing = findTaskByRunId(taskRunId);
      if (existing?.runtime === "cron" && existing.status === "cancelled") {
        // Operator cancellation owns task status and reason; its finished event owns history detail.
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
        const recreated = tryCreateCronTaskRunRecord({
          state,
          job: result.job ?? result.event.job,
          jobId: entry.jobId,
          startedAt,
          runId: taskRunId,
          childSessionKey: entry.sessionKey,
        });
        if (recreated) {
          updated = finalize(recreated.runId);
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
