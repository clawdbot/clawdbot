/** Detached task-ledger integration for cron runs. */
import { randomUUID } from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";

function requireCronAgentId(agentId: string | undefined): string {
  if (!agentId?.trim()) {
    throw new Error("Cron task run requires an agent id or prepared configured default.");
  }
  return normalizeAgentId(agentId);
}

function resolveCurrentDefaultAgentId(state: CronServiceState): string | undefined {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}
import {
  createRunningTaskRun,
  finalizeTaskRunById,
  finalizeTaskRunByRunId,
  findTaskByRunId,
  listTaskRecordsUnsorted,
} from "../../tasks/task-executor.js";
import type { JsonValue, TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { resolveCronAgentSessionKey } from "../isolated-agent/session-key.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import { cronStoreKey } from "../store/key.js";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
  cronTaskRecordStoreKey,
  cronTaskRecordToRunLogEntry,
  cronTaskRecordToScriptRunResult,
  cronTaskRecordToTriggerEval,
  resolveCronTaskRecordTimestamp,
} from "../task-run-detail.js";
import { cronRunLogEntryFromEvent } from "../task-run-event-codec.js";
import type { CronJob, CronRunErrorClassification, CronRunStatus } from "../types.js";
import { normalizeCronRunErrorText, timeoutErrorMessage } from "./execution-errors.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { CRON_TASK_RUNNING_PROGRESS_SUMMARY } from "./task-ledger.js";

/** Converts cron ids into bounded session-key path segments with a fallback for empty input. */
export function normalizeCronLaneSegment(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalLowercaseString(value)
    ?.replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

/** Builds the main-session child key used to isolate one cron run's task transcript. */
export function resolveMainSessionCronRunSessionKey(
  job: CronJob,
  startedAt: number,
  configuredDefaultAgentId: string | undefined,
): string {
  const agentId = resolveCronJobEffectiveAgentId(job, configuredDefaultAgentId);
  const jobSegment = normalizeCronLaneSegment(job.id, "job");
  const runSegment = normalizeCronLaneSegment(String(Math.max(0, Math.floor(startedAt))), "run");
  return `agent:${agentId}:cron:${jobSegment}:run:${runSegment}`;
}

function resolveCronTaskChildSessionKey(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const explicitAgentId = params.job.agentId?.trim() || undefined;
  if (params.job.sessionTarget === "main") {
    return resolveMainSessionCronRunSessionKey(
      params.job,
      params.startedAt,
      resolveCurrentDefaultAgentId(params.state),
    );
  }
  if (params.job.sessionTarget === "current") {
    const scopedAgentId = parseAgentSessionKey(params.job.sessionKey)?.agentId;
    return resolveCronAgentSessionKey({
      sessionKey: `cron:${params.job.id}`,
      agentId: requireCronAgentId(
        explicitAgentId ?? scopedAgentId ?? resolveCurrentDefaultAgentId(params.state),
      ),
    });
  }
  const explicitSessionKey = params.job.sessionKey?.trim();
  if (explicitSessionKey) {
    // Explicit session bindings must win over generated cron session keys so
    // task drill-down opens the same transcript the cron run actually used.
    return explicitSessionKey;
  }
  if (params.job.sessionTarget !== "isolated") {
    return undefined;
  }
  return resolveCronAgentSessionKey({
    sessionKey: `cron:${params.job.id}`,
    agentId: resolveCronJobEffectiveAgentId(params.job, resolveCurrentDefaultAgentId(params.state)),
  });
}

/** Creates a best-effort detached task ledger row for a cron run. */
export function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
  runIdStartedAt?: number;
  publicRunId?: string;
}): string | undefined {
  const runId = createCronTaskRunId(
    params.job.id,
    params.runIdStartedAt ?? params.startedAt,
    params.publicRunId,
  );
  return tryCreateCronTaskRunRecord({
    state: params.state,
    job: params.job,
    jobId: params.job.id,
    startedAt: params.startedAt,
    runId,
  });
}

function createCronTaskRunId(jobId: string, reservationAt: number, publicRunId?: string): string {
  const discriminator = publicRunId?.trim() || randomUUID();
  return `${createCronExecutionId(jobId, reservationAt)}:${discriminator}`;
}

function findLatestCronTaskRunForRecovery(
  jobId: string,
  reservationAt: number,
  storeKey: string,
): TaskRecord | undefined {
  const reservationRunId = createCronExecutionId(jobId, reservationAt);
  const prefix = `${reservationRunId}:`;
  return listTaskRecordsUnsorted()
    .filter((task) => {
      if (task.runtime !== "cron" || task.sourceId !== jobId) {
        return false;
      }
      const taskStoreKey = cronTaskRecordStoreKey(task);
      if (taskStoreKey === undefined) {
        // Exact match covers detail-less pre-discriminator rows from older releases.
        return task.runId === reservationRunId;
      }
      return (
        taskStoreKey === storeKey &&
        (task.runId === reservationRunId || task.runId?.startsWith(prefix))
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

/** Finds the unique task identity owned by one persisted cron reservation. */
export function tryFindCronTaskRunIdForRecovery(
  state: CronServiceState,
  jobId: string,
  startedAt: number,
): string | undefined {
  try {
    return findLatestCronTaskRunForRecovery(jobId, startedAt, cronStoreKey(state.deps.storePath))
      ?.runId;
  } catch (error) {
    state.deps.log.warn({ jobId, error }, "cron: failed to read task ledger recovery record");
    return undefined;
  }
}

/** Finds a completed canonical cron row for startup crash recovery. */
export function tryFindFinalizedCronTaskRun(
  state: CronServiceState,
  jobId: string,
  startedAt: number,
):
  | {
      entry: CronRunLogEntry & { status: CronRunStatus };
      scriptResult?: { scriptStateChanged: true; scriptState?: JsonValue };
      triggerEval?: { fired: true; stateChanged: boolean; state?: JsonValue };
    }
  | undefined {
  try {
    const task = findLatestCronTaskRunForRecovery(
      jobId,
      startedAt,
      cronStoreKey(state.deps.storePath),
    );
    if (task?.runtime !== "cron" || task.sourceId !== jobId || task.endedAt === undefined) {
      return undefined;
    }
    const entry = cronTaskRecordToRunLogEntry(task);
    if (!entry?.status) {
      return undefined;
    }
    const triggerEval = cronTaskRecordToTriggerEval(task);
    const scriptResult = cronTaskRecordToScriptRunResult(task);
    return {
      entry: { ...entry, status: entry.status },
      ...(scriptResult ? { scriptResult } : {}),
      ...(triggerEval ? { triggerEval } : {}),
    };
  } catch (error) {
    state.deps.log.warn({ jobId, error }, "cron: failed to read finalized task ledger record");
    return undefined;
  }
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
    const explicitJobAgentId = params.job?.agentId?.trim();
    const childSessionKey =
      params.childSessionKey ??
      (params.job
        ? resolveCronTaskChildSessionKey({
            state: params.state,
            job: params.job,
            startedAt: params.startedAt,
          })
        : undefined);
    const effectiveJobAgentId = params.job
      ? resolveCronJobEffectiveAgentId(params.job, resolveCurrentDefaultAgentId(params.state))
      : undefined;
    const task = createRunningTaskRun({
      runtime: "cron",
      sourceId: params.jobId,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey,
      agentId:
        effectiveJobAgentId ??
        (explicitJobAgentId ? normalizeAgentId(explicitJobAgentId) : undefined) ??
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
  },
): void {
  if (!result.taskRunId) {
    return;
  }
  const error = result.status === "error" ? normalizeCronRunErrorText(result.error) : undefined;
  try {
    finalizeTaskRunByRunId({
      runId: result.taskRunId,
      runtime: "cron",
      status:
        result.status === "ok" || result.status === "skipped"
          ? "succeeded"
          : error === timeoutErrorMessage()
            ? "timed_out"
            : "failed",
      endedAt: result.endedAt,
      lastEventAt: result.endedAt,
      error,
      terminalSummary: result.summary,
      childSessionKey: result.childSessionKey,
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
      finalizeTaskRunByRunId({
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
