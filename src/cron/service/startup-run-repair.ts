/** Repairs interrupted and finalized cron runs while the service starts. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveCronCompletionStatus } from "../completion-status.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { maybeAutoDisableCronJobAfterRunFailure } from "./auto-disable.js";
import { finalizeCronFailureNotifications, resolveFailureAlert } from "./failure-alerts.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import type { CronTriggerEvalOutcome } from "./timer-execution-timeout.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerNoFireResult,
} from "./timer-outcomes.js";
import { applyTriggerRunResult } from "./timer-trigger.js";

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

export function markInterruptedStartupRun(params: {
  state: CronServiceState;
  job: CronJob;
  taskRunId?: string;
  runningAtMs: number;
  nowMs: number;
  recoverInterruptedOneShot?: boolean;
  deferredNotifications?: DeferredCronNotifications;
}): InterruptedStartupRun {
  const { job, runningAtMs, nowMs } = params;
  const replacementAtMs = resolveOneShotReplacementAtMs(job, runningAtMs);
  // A persisted running marker means the gateway stopped mid-run; mark it as a
  // normal failed run so retries, alerts, and run logs all see one outcome.
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
  job.state.deliverySuppressionReason = undefined;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "not-requested";
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.nextRunAtMs = replacementAtMs;
  job.state.startupCatchupAtMs = undefined;
  job.updatedAtMs = nowMs;

  const alertConfig = resolveFailureAlert(params.state, job);
  const autoDisableNotificationOwnsFailure = maybeAutoDisableCronJobAfterRunFailure({
    state: params.state,
    job,
    atMs: nowMs,
    deferredNotifications: params.deferredNotifications,
  });
  if (autoDisableNotificationOwnsFailure) {
    params.state.deps.log.error(
      { jobId: job.id, name: job.name, consecutiveErrors: job.state.consecutiveErrors },
      "cron: auto-disabled interrupted job after consecutive run failures",
    );
  }
  finalizeCronFailureNotifications(params.state, {
    job,
    alertConfig,
    result: {
      status: "error",
      error: STARTUP_INTERRUPTED_ERROR,
      startedAt: runningAtMs,
    },
    completionFailed: false,
    autoDisableNotificationOwnsFailure,
    deferredNotifications: params.deferredNotifications,
  });

  // Live owner reclamation consumes an already-started one-shot. Only startup
  // recovery may replay it; an operator's distinct replacement stays scheduled.
  if (
    job.schedule.kind === "at" &&
    replacementAtMs === undefined &&
    !params.recoverInterruptedOneShot
  ) {
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
  const persistedNextRunAtMs = asDateTimestampMs(job.state.nextRunAtMs);
  // Finalization writes history first, so a later one-shot slot or disable in
  // the job row owns lifecycle state when startup replays that older history.
  const scheduleOwnership =
    job.schedule.kind === "at" &&
    (!job.enabled || (persistedNextRunAtMs !== undefined && persistedNextRunAtMs > startedAt))
      ? "stale"
      : "current";
  job.state.startupCatchupAtMs = undefined;
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
      completionStatus:
        entry.completionStatus ??
        resolveCronCompletionStatus({
          status: entry.status,
          delivered: entry.delivered,
          deliveryStatus: entry.deliveryStatus,
        }),
      // Recovery uses the finished run's fact, never the job's possibly edited route.
      deliveryState: {
        delivered: entry.delivered,
        status: entry.deliveryStatus ?? "unknown",
        error: entry.deliveryError,
        deliverySuppressionReason: entry.deliverySuppressionReason,
        failureNotification: entry.failureNotificationDelivery ?? { status: "not-requested" },
      },
      startedAt,
      endedAt,
    },
    {
      replay: true,
      scheduleOwnership,
      ...(scheduleOwnership === "current"
        ? { replaySchedule: { nextRunAtMs: entry.nextRunAtMs } }
        : {}),
      deferredNotifications: params.deferredNotifications,
    },
  );

  // The finalized row captured post-run state before the stale cron store write.
  job.state.lastDurationMs = entry.durationMs ?? Math.max(0, endedAt - startedAt);
  job.state.lastErrorReason = entry.errorReason;
  if (entry.failureNotificationDelivery) {
    job.state.lastFailureNotificationDelivered = entry.failureNotificationDelivery.delivered;
    job.state.lastFailureNotificationDeliveryStatus = entry.failureNotificationDelivery.status;
    job.state.lastFailureNotificationDeliveryError = entry.failureNotificationDelivery.error;
    const lastAlert = job.state.lastFailureAlertAtMs;
    // Recorded alert intent owns its cooldown even if today's route/policy changed.
    if (
      entry.failureNotificationDelivery.status !== "not-requested" &&
      (lastAlert === undefined || lastAlert < endedAt || lastAlert > state.deps.nowMs())
    ) {
      job.state.lastFailureAlertAtMs = endedAt;
    }
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
