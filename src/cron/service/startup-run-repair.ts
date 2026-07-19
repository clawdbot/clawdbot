/** Repairs interrupted and finalized cron runs while the service starts. */
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState } from "./state.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerRunResult,
  type CronTriggerEvalOutcome,
} from "./timer.js";

export const STARTUP_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";

export type InterruptedStartupRun = {
  jobId: string;
  taskRunId?: string;
  runAtMs: number;
  durationMs: number;
};

function resolveInterruptedStartupFailureNotificationStatus(params: {
  state: CronServiceState;
  job: CronJob;
}) {
  if (params.job.delivery?.bestEffort === true) {
    return "not-requested";
  }
  if (resolveFailureDestination(params.job, params.state.deps.cronConfig?.failureDestination)) {
    return "unknown";
  }
  const primaryPlan = resolveCronDeliveryPlan(params.job);
  return primaryPlan.mode === "announce" && primaryPlan.requested ? "unknown" : "not-requested";
}

export function markInterruptedStartupRun(params: {
  state: CronServiceState;
  job: CronJob;
  taskRunId?: string;
  runningAtMs: number;
  nowMs: number;
}): InterruptedStartupRun {
  const { job, runningAtMs, nowMs } = params;
  // A persisted running marker means the gateway stopped mid-run; mark it as a
  // normal failed run so retries, alerts, and run logs all see one outcome.
  const failureNotificationStatus = resolveInterruptedStartupFailureNotificationStatus({
    state: params.state,
    job,
  });
  const previousErrors =
    typeof job.state.consecutiveErrors === "number" && Number.isFinite(job.state.consecutiveErrors)
      ? Math.max(0, Math.floor(job.state.consecutiveErrors))
      : 0;

  params.state.deps.log.warn(
    { jobId: job.id, runningAtMs },
    "cron: marking interrupted running job failed on startup",
  );

  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = runningAtMs;
  job.state.lastRunStatus = "error";
  job.state.lastStatus = "error";
  job.state.lastError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
  job.state.consecutiveErrors = previousErrors + 1;
  job.state.lastDelivered = false;
  job.state.lastDeliveryStatus = "unknown";
  job.state.lastDeliveryError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = failureNotificationStatus;
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.nextRunAtMs = undefined;
  job.updatedAtMs = nowMs;

  if (job.schedule.kind === "at") {
    job.enabled = false;
  }

  return {
    jobId: job.id,
    ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
    runAtMs: runningAtMs,
    durationMs: job.state.lastDurationMs,
  };
}

export function restoreFinalizedStartupRun(params: {
  state: CronServiceState;
  job: CronJob;
  runningAtMs: number;
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: unknown };
  triggerEval?: CronTriggerEvalOutcome;
}): boolean {
  const { state, job, runningAtMs, entry } = params;
  const startedAt = entry.runAtMs ?? runningAtMs;
  const shouldDelete = applyJobResult(
    state,
    job,
    {
      ...entry,
      startedAt,
      endedAt: entry.ts,
    },
    { replayFailureAlertAtMs: entry.ts },
  );

  // The finalized row captured post-run state before the stale cron store write.
  job.state.lastDurationMs = entry.durationMs ?? Math.max(0, entry.ts - startedAt);
  job.state.lastErrorReason = entry.errorReason;
  job.state.lastDelivered = entry.delivered;
  job.state.lastDeliveryStatus = entry.deliveryStatus;
  job.state.lastDeliveryError = entry.deliveryError;
  job.state.lastFailureNotificationDelivered = entry.failureNotificationDelivery?.delivered;
  job.state.lastFailureNotificationDeliveryStatus = entry.failureNotificationDelivery?.status;
  job.state.lastFailureNotificationDeliveryError = entry.failureNotificationDelivery?.error;
  job.state.nextRunAtMs = entry.nextRunAtMs;
  // The finalized ledger row owns the schedule decision made before the stale
  // store write. No next run means that one-shot was permanently disabled.
  if (job.schedule.kind === "at" && entry.nextRunAtMs === undefined) {
    job.enabled = false;
  }
  if (params.triggerEval) {
    applyTriggerRunResult(job, {
      status: entry.status,
      endedAt: entry.ts,
      triggerEval: params.triggerEval,
    });
  }
  if (params.scriptResult) {
    // The payload script is the final writer when a trigger and payload both
    // update their shared state during the same successful run.
    applyScriptRunResult(job, { status: entry.status, ...params.scriptResult });
  }
  state.deps.log.info(
    { jobId: job.id, runningAtMs, status: entry.status },
    "cron: restored finalized task-ledger run on startup",
  );
  return shouldDelete;
}

export function mergeManualRunSnapshotAfterReload(params: {
  state: CronServiceState;
  jobId: string;
  snapshot: {
    enabled: boolean;
    updatedAtMs: number;
    state: CronJob["state"];
  } | null;
  removed: boolean;
}) {
  if (!params.state.store) {
    return;
  }
  if (params.removed) {
    params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
    return;
  }
  if (!params.snapshot) {
    return;
  }
  const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
  if (!reloaded) {
    return;
  }
  reloaded.enabled = params.snapshot.enabled;
  reloaded.updatedAtMs = params.snapshot.updatedAtMs;
  reloaded.state = params.snapshot.state;
}
