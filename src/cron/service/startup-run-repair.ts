/** Repairs interrupted and finalized cron runs while the service starts. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { maybeAutoDisableCronJobAfterRunFailure } from "./auto-disable.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import type { CronTriggerEvalOutcome } from "./timer-execution-timeout.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerNoFireResult,
} from "./timer-outcomes.js";
import { applyTriggerRunResult, resolveNextRunAtMsOrDisable } from "./timer-trigger.js";

export const STARTUP_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";

export type InterruptedStartupRun = {
  jobId: string;
  taskRunId?: string;
  runAtMs: number;
  durationMs: number;
  replacementAtMs?: number;
};

function resolveOneShotReplacementAtMs(job: CronJob, runningAtMs: number): number | undefined {
  if (job.schedule.kind !== "at" || !job.enabled) {
    return undefined;
  }
  const nextRunAtMs = job.state.nextRunAtMs;
  if (typeof nextRunAtMs !== "number" || nextRunAtMs <= runningAtMs) {
    return undefined;
  }
  // Compare against the run's durable start, not the restart clock: a newer
  // one-shot may already be overdue and must remain eligible for catch-up.
  return parseAbsoluteTimeMs(job.schedule.at) === nextRunAtMs ? nextRunAtMs : undefined;
}

function resolveInterruptedStartupFailureNotificationStatus(params: {
  state: CronServiceState;
  job: CronJob;
}) {
  if (params.job.delivery?.bestEffort === true) {
    return "not-requested";
  }
  if (resolveFailureDestination(params.job, params.state.deps.cronConfig?.failureAlert)) {
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
  deferredNotifications?: DeferredCronNotifications;
}): InterruptedStartupRun {
  const { job, runningAtMs, nowMs } = params;
  const replacementAtMs = resolveOneShotReplacementAtMs(job, runningAtMs);
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
  job.state.lastErrorReason = undefined;
  job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
  job.state.consecutiveErrors = previousErrors + 1;
  job.state.lastDelivered = false;
  job.state.lastDeliveryStatus = "unknown";
  job.state.lastDeliveryError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = failureNotificationStatus;
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.nextRunAtMs = replacementAtMs;
  job.updatedAtMs = nowMs;

  if (
    maybeAutoDisableCronJobAfterRunFailure({
      state: params.state,
      job,
      atMs: nowMs,
      deferredNotifications: params.deferredNotifications,
    })
  ) {
    params.state.deps.log.error(
      { jobId: job.id, name: job.name, consecutiveErrors: job.state.consecutiveErrors },
      "cron: auto-disabled interrupted job after consecutive run failures",
    );
  }

  if (job.schedule.kind === "at" && replacementAtMs === undefined) {
    job.enabled = false;
  }

  return {
    jobId: job.id,
    ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
    ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
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
  deferredNotifications?: DeferredCronNotifications;
}): { shouldDelete: boolean; replacementAtMs?: number } | undefined {
  const { state, job, runningAtMs, entry } = params;
  const startedAt = asDateTimestampMs(entry.runAtMs ?? runningAtMs);
  const endedAt = asDateTimestampMs(entry.ts);
  if (startedAt === undefined || startedAt < 0 || endedAt === undefined || endedAt < 0) {
    state.deps.log.warn(
      { jobId: job.id },
      "cron: ignoring finalized startup run with an invalid timestamp envelope",
    );
    return undefined;
  }
  const replacementAtMs = resolveOneShotReplacementAtMs(job, startedAt);
  const scheduleOwnership = replacementAtMs === undefined ? "current" : "stale";
  if (params.triggerEval?.fired === false) {
    applyTriggerNoFireResult(
      state,
      job,
      { startedAt, endedAt, triggerEval: params.triggerEval },
      {
        scheduleMode: scheduleOwnership === "stale" ? "stale-preserve" : "advance",
        deferredNotifications: params.deferredNotifications,
      },
    );
    return {
      shouldDelete: false,
      ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
    };
  }
  const shouldDelete = applyJobResult(
    state,
    job,
    {
      ...entry,
      startedAt,
      endedAt,
    },
    {
      replayFailureAlertAtMs: endedAt,
      scheduleOwnership,
      deferredNotifications: params.deferredNotifications,
    },
  );

  // The finalized row captured post-run state before the stale cron store write.
  job.state.lastDurationMs = entry.durationMs ?? Math.max(0, endedAt - startedAt);
  job.state.lastErrorReason = entry.errorReason;
  job.state.lastDelivered = entry.delivered;
  job.state.lastDeliveryStatus = entry.deliveryStatus;
  job.state.lastDeliveryError = entry.deliveryError;
  job.state.lastFailureNotificationDelivered = entry.failureNotificationDelivery?.delivered;
  job.state.lastFailureNotificationDeliveryStatus = entry.failureNotificationDelivery?.status;
  job.state.lastFailureNotificationDeliveryError = entry.failureNotificationDelivery?.error;
  const finalizedNextRunAtMs = replacementAtMs ?? entry.nextRunAtMs;
  job.state.nextRunAtMs =
    job.state.autoDisabled || finalizedNextRunAtMs === undefined
      ? undefined
      : resolveNextRunAtMsOrDisable({
          state,
          job,
          candidate: finalizedNextRunAtMs,
          deferredNotifications: params.deferredNotifications,
        });
  // The finalized ledger row owns the schedule decision made before the stale
  // store write. No next run means that one-shot was permanently disabled.
  if (
    job.schedule.kind === "at" &&
    replacementAtMs === undefined &&
    entry.nextRunAtMs === undefined
  ) {
    job.enabled = false;
  }
  if (params.triggerEval) {
    applyTriggerRunResult(
      job,
      {
        status: entry.status,
        endedAt,
        triggerEval: params.triggerEval,
      },
      { scheduleOwnership },
    );
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
  return {
    shouldDelete,
    ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
  };
}
