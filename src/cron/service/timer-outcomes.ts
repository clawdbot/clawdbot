import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import { resolvePacedNextRunAtMs } from "../pacing.js";
import { normalizeCronRunDiagnostics, summarizeCronRunDiagnostics } from "../run-diagnostics.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
import { computeNextRunAtMs } from "../schedule.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import type { CronJob, CronRunStatus } from "../types.js";
import {
  failureNotificationDeliveryFromJobState,
  maybeEmitFailureAlert,
  resolveFailureAlert,
} from "./failure-alerts.js";
import {
  computeJobNextRunAtMs,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  errorBackoffMs,
  isJobEnabled,
  recordScheduleComputeError,
} from "./jobs.js";
import { type CronServiceState, emit } from "./state.js";
import { tryFinishCronTaskRun, tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import {
  type CronJobRunResult,
  type CronTriggerEvalOutcome,
  MIN_REFIRE_GAP_MS,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import {
  resolveCronNextRunWithLowerBound,
  resolveDeliveryState,
  resolveDisabledHeartbeatOneShotRetryDecision,
  resolveTransientCronRetryDecision,
  shouldRetryDisabledHeartbeatOneShot,
} from "./timer-trigger.js";

/** Applies run outcome state, delivery state, backoff/next-run scheduling, and delete-after-run policy. */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: CronJobRunResult,
  opts?: {
    // Manual force runs update outcome state but are out-of-band for cadence.
    scheduleMode?: "advance" | "preserve";
    // Startup replay restores alert cooldown bookkeeping without redelivery.
    replayFailureAlertAtMs?: number;
    // Manual runs should never trigger deleteAfterRun.
    isManual?: boolean;
  },
): boolean {
  const previousScheduleState = {
    nextRunAtMs: job.state.nextRunAtMs,
    pacedNextRunAtMs: job.state.pacedNextRunAtMs,
  };
  job.state.queuedAtMs = undefined;
  job.state.runningAtMs = undefined;
  job.state.pacedNextRunAtMs = undefined;
  job.state.forcePreservedNextRunAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = result.status;
  job.state.lastRunWasManual = opts?.isManual === true;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.state.lastDiagnostics = normalizeCronRunDiagnostics(result.diagnostics);
  job.state.lastDiagnosticSummary = summarizeCronRunDiagnostics(job.state.lastDiagnostics);
  job.state.lastErrorReason =
    result.status === "error" && typeof result.error === "string"
      ? resolveCronRunErrorReason(result.error, result.provider, result.errorClassification)
      : undefined;
  if (result.status === "error") {
    state.deps.log.warn(
      {
        jobId: job.id,
        jobName: job.name,
        error: result.error,
        diagnosticsSummary: job.state.lastDiagnosticSummary,
      },
      "cron: job run returned error status",
    );
  }
  const deliveryState = resolveDeliveryState({
    job,
    runStatus: result.status,
    delivered: result.delivered,
    // A successful run keeps `error` empty but may carry a dedicated
    // `deliveryError` when post-run delivery failed (#94058/#95419); prefer it
    // so `lastDeliveryError` is populated without conflating it with a
    // run-level failure. Error runs fall back to the run error as before.
    error: result.deliveryError ?? result.error,
    globalFailureDestination: state.deps.cronConfig?.failureAlert,
  });
  job.state.lastDelivered = deliveryState.delivered;
  job.state.lastDeliveryStatus = deliveryState.status;
  job.state.lastDeliveryError =
    deliveryState.status === "not-delivered" && deliveryState.error
      ? deliveryState.error
      : undefined;
  job.state.lastFailureNotificationDelivered = deliveryState.failureNotification.delivered;
  job.state.lastFailureNotificationDeliveryStatus = deliveryState.failureNotification.status;
  job.state.lastFailureNotificationDeliveryError = deliveryState.failureNotification.error;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable; skipped runs use a
  // separate counter so opt-in skip alerts do not affect retry behavior.
  const previousConsecutiveErrors = job.state.consecutiveErrors ?? 0;
  const alertConfig = resolveFailureAlert(state, job);
  if (result.status === "error") {
    if (!opts?.isManual) {
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
      job.state.consecutiveSkipped = 0;
      maybeEmitFailureAlert(state, {
        job,
        alertConfig,
        status: "error",
        error: result.error,
        errorReason: job.state.lastErrorReason,
        consecutiveCount: job.state.consecutiveErrors,
        ...(opts?.replayFailureAlertAtMs !== undefined
          ? { delivery: "record-only" as const, occurredAtMs: opts.replayFailureAlertAtMs }
          : {}),
      });
    }
  } else if (result.status === "skipped") {
    if (!opts?.isManual) {
      job.state.consecutiveErrors = 0;
      job.state.consecutiveSkipped = (job.state.consecutiveSkipped ?? 0) + 1;
      if (alertConfig?.includeSkipped) {
        maybeEmitFailureAlert(state, {
          job,
          alertConfig,
          status: "skipped",
          error: result.error,
          consecutiveCount: job.state.consecutiveSkipped,
          ...(opts?.replayFailureAlertAtMs !== undefined
            ? { delivery: "record-only" as const, occurredAtMs: opts.replayFailureAlertAtMs }
            : {}),
        });
      } else {
        job.state.lastFailureAlertAtMs = undefined;
      }
    }
  } else {
    if (!opts?.isManual) {
      job.state.consecutiveErrors = 0;
      job.state.consecutiveSkipped = 0;
      job.state.lastFailureAlertAtMs = undefined;
    }
  }

  // The gateway watcher disables on-exit jobs before firing; successful removal here
  // completes the same deleteAfterRun contract as a one-shot at schedule.
  const isOneShotSchedule = job.schedule.kind === "at" || job.schedule.kind === "on-exit";
  const wouldDelete = isOneShotSchedule && job.deleteAfterRun === true && result.status === "ok";
  const retryDisabledHeartbeatOneShot = shouldRetryDisabledHeartbeatOneShot(job, result);

  const shouldDelete = wouldDelete && !opts?.isManual;

  if (wouldDelete && opts?.isManual) {
    state.deps.log.info(
      { jobId: job.id, jobName: job.name },
      "cron: skipping deleteAfterRun for manual run — job preserved for scheduled execution",
    );
  }

  if (!shouldDelete) {
    if (job.schedule.kind === "at") {
      if (retryDisabledHeartbeatOneShot) {
        if (!opts?.isManual) {
          // Manual runs never disable the one-shot or reschedule a retry; the
          // scheduled execution path stays intact (#83538).
          const retryDecision = resolveDisabledHeartbeatOneShotRetryDecision({
            cronConfig: state.deps.cronConfig,
            consecutiveSkipped: job.state.consecutiveSkipped,
          });
          if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
            job.enabled = true;
            job.state.nextRunAtMs = result.endedAt + retryDecision.backoffMs;
            state.deps.log.info(
              {
                jobId: job.id,
                jobName: job.name,
                consecutiveSkipped: retryDecision.consecutiveSkipped,
                backoffMs: retryDecision.backoffMs,
                nextRunAtMs: job.state.nextRunAtMs,
              },
              "cron: scheduling one-shot retry after disabled heartbeat",
            );
          } else {
            job.enabled = false;
            job.state.nextRunAtMs = undefined;
            state.deps.log.warn(
              {
                jobId: job.id,
                jobName: job.name,
                consecutiveSkipped: retryDecision.consecutiveSkipped,
                reason: retryDecision.reason,
              },
              "cron: disabling one-shot job after disabled heartbeat retries",
            );
          }
        }
      } else if (result.status === "ok" || result.status === "skipped") {
        if (!opts?.isManual) {
          // One-shot done or skipped: disable to prevent tight-loop (#11452).
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
        }
      } else if (result.status === "error") {
        if (opts?.isManual) {
          // Manual runs do not participate in at-job retry/disable state.
          // Leave enabled, nextRunAtMs, and counters unchanged so the
          // scheduled execution path is not affected.
          state.deps.log.info(
            { jobId: job.id, jobName: job.name },
            "cron: skipping at-job error handling for manual run — job preserved for scheduled execution",
          );
        } else {
          const retryDecision = resolveTransientCronRetryDecision({
            cronConfig: state.deps.cronConfig,
            error: result.error,
            errorClassification: result.errorClassification,
            lastErrorReason: job.state.lastErrorReason,
            executionStarted: result.executionStarted,
            consecutiveErrors: job.state.consecutiveErrors,
          });
          if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
            // Schedule retry with backoff (#24355).
            job.state.nextRunAtMs = result.endedAt + retryDecision.backoffMs;
            state.deps.log.info(
              {
                jobId: job.id,
                jobName: job.name,
                consecutiveErrors: retryDecision.consecutiveErrors,
                backoffMs: retryDecision.backoffMs,
                nextRunAtMs: job.state.nextRunAtMs,
                retryCategory: retryDecision.retryCategory,
              },
              "cron: scheduling one-shot retry after transient error",
            );
          } else {
            // Permanent error or max retries exhausted: disable.
            // Note: deleteAfterRun:true only triggers on ok (see shouldDelete above),
            // so exhausted-retry jobs are disabled but intentionally kept in the store
            // to preserve the error state for inspection.
            job.enabled = false;
            job.state.nextRunAtMs = undefined;
            state.deps.log.warn(
              {
                jobId: job.id,
                jobName: job.name,
                consecutiveErrors: retryDecision.consecutiveErrors,
                error: result.error,
                reason: retryDecision.reason,
                retryCategory: retryDecision.retryCategory,
              },
              "cron: disabling one-shot job after error",
            );
          }
        }
      }
    } else if (opts?.scheduleMode === "preserve") {
      // Forced recurring runs do not consume, replace, or repair a scheduled
      // slot. Preserve the timestamp and its paced provenance as one unit.
      job.state.nextRunAtMs = previousScheduleState.nextRunAtMs;
      job.state.pacedNextRunAtMs = previousScheduleState.pacedNextRunAtMs;
      job.state.forcePreservedNextRunAtMs = previousScheduleState.nextRunAtMs;
    } else if (result.status === "error" && isJobEnabled(job)) {
      const retryDecision = resolveTransientCronRetryDecision({
        cronConfig: state.deps.cronConfig,
        error: result.error,
        errorClassification: result.errorClassification,
        lastErrorReason: job.state.lastErrorReason,
        executionStarted: result.executionStarted,
        consecutiveErrors: job.state.consecutiveErrors,
      });
      let normalNext: number | undefined;
      let normalNextComputed = false;
      const computeNormalNext = () => {
        if (!normalNextComputed) {
          try {
            normalNext =
              (retryDecision.retryable || previousConsecutiveErrors > 0) &&
              job.schedule.kind === "every"
                ? computeNextRunAtMs(job.schedule, result.endedAt)
                : computeJobNextRunAtMs(job, result.endedAt);
          } catch (err) {
            // If the schedule expression/timezone throws (croner edge cases),
            // record the schedule error (auto-disables after repeated failures)
            // and fall back to backoff-only schedule so the state update is not lost.
            recordScheduleComputeError({ state, job, err });
          }
          normalNextComputed = true;
        }
        return normalNext;
      };
      if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
        normalNext = computeNormalNext();
        const retryNextRunAtMs = result.endedAt + retryDecision.backoffMs;
        if (normalNext === undefined) {
          // Preserve the unresolved-cron guard (#66019): do not synthesize a
          // retry when the schedule cannot produce a next scheduled slot.
        } else if (retryNextRunAtMs < normalNext) {
          job.state.nextRunAtMs = retryNextRunAtMs;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: retryDecision.consecutiveErrors,
              backoffMs: retryDecision.backoffMs,
              nextRunAtMs: job.state.nextRunAtMs,
              normalNextRunAtMs: normalNext,
              retryCategory: retryDecision.retryCategory,
            },
            "cron: scheduling recurring retry after transient error",
          );
          return shouldDelete;
        }
      }
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(
        job.state.consecutiveErrors ?? 1,
        DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
      normalNext = computeNormalNext();
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        job.schedule.kind === "cron"
          ? resolveCronNextRunWithLowerBound({
              state,
              job,
              naturalNext: normalNext,
              lowerBoundMs: backoffNext,
              context: "error_backoff",
            })
          : normalNext !== undefined
            ? Math.max(normalNext, backoffNext)
            : backoffNext;
      state.deps.log.info(
        {
          jobId: job.id,
          consecutiveErrors: job.state.consecutiveErrors,
          backoffMs: backoff,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        "cron: applying error backoff",
      );
    } else if (
      isJobEnabled(job) &&
      result.status === "ok" &&
      job.pacing !== undefined &&
      result.nextCheck !== undefined
    ) {
      // Pacing bounds are the explicit per-job cadence contract. Do not apply
      // normal schedule floors here; that would change the promised clamp.
      const pacedNextRunAtMs = resolvePacedNextRunAtMs({
        nowMs: result.endedAt,
        delayMs: result.nextCheck.delayMs,
        pacing: job.pacing,
      });
      // The operator trigger floor is a safety policy and outranks a job-local
      // pacing bound. Non-trigger jobs retain the exact pacing clamp contract.
      const nextRunAtMs = job.trigger
        ? Math.max(
            pacedNextRunAtMs,
            result.endedAt + Math.max(MIN_REFIRE_GAP_MS, resolveCronTriggerMinIntervalMs()),
          )
        : pacedNextRunAtMs;
      job.state.nextRunAtMs = nextRunAtMs;
      job.state.pacedNextRunAtMs = nextRunAtMs;
    } else if (isJobEnabled(job)) {
      let naturalNext: number | undefined;
      try {
        naturalNext =
          previousConsecutiveErrors > 0 && job.schedule.kind === "every"
            ? computeNextRunAtMs(job.schedule, result.endedAt)
            : computeJobNextRunAtMs(job, result.endedAt);
      } catch (err) {
        // If the schedule expression/timezone throws (croner edge cases),
        // record the schedule error (auto-disables after repeated failures)
        // so a persistent throw doesn't cause a MIN_REFIRE_GAP_MS hot loop.
        recordScheduleComputeError({ state, job, err });
      }
      if (job.schedule.kind === "cron") {
        // Safety net: ensure the next fire is at least MIN_REFIRE_GAP_MS
        // after the current run ended.  Prevents spin-loops when the
        // schedule computation lands in the same second due to
        // timezone/croner edge cases (see #17821).
        // Trigger schedules obey the operator floor even when a cron expression
        // would otherwise refire sooner after a successful payload run.
        const minNext =
          result.endedAt +
          Math.max(MIN_REFIRE_GAP_MS, job.trigger ? resolveCronTriggerMinIntervalMs() : 0);
        job.state.nextRunAtMs = resolveCronNextRunWithLowerBound({
          state,
          job,
          naturalNext,
          lowerBoundMs: minNext,
          context: "completion",
        });
      } else {
        job.state.nextRunAtMs =
          naturalNext !== undefined && job.trigger
            ? Math.max(naturalNext, result.endedAt + resolveCronTriggerMinIntervalMs())
            : naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

function applyTriggerEvaluationState(
  job: CronJob,
  triggerEval: CronTriggerEvalOutcome,
  evaluatedAtMs: number,
): void {
  if (triggerEval.busy) {
    return;
  }
  job.state.lastTriggerEvalAtMs = evaluatedAtMs;
  job.state.triggerEvalCount = (job.state.triggerEvalCount ?? 0) + 1;
  if (triggerEval.stateChanged) {
    job.state.triggerState = triggerEval.state;
  }
  if (triggerEval.fired) {
    job.state.lastTriggerFireAtMs = evaluatedAtMs;
  }
}

/** Persists fired/error evaluation metadata and applies successful once-disarm policy. */
export function applyTriggerRunResult(
  job: CronJob,
  result: { status: CronRunStatus; endedAt: number; triggerEval?: CronTriggerEvalOutcome },
): void {
  if (!result.triggerEval) {
    return;
  }
  // Fired-run trigger state persists only on payload success: a failed or
  // skipped run keeps the previous state so the next evaluation re-detects
  // the change and fires again instead of silently losing the event.
  const persistedEval =
    result.status === "ok"
      ? result.triggerEval
      : { ...result.triggerEval, stateChanged: false, state: undefined };
  applyTriggerEvaluationState(job, persistedEval, result.endedAt);
  // A once trigger disarms only after the fired payload succeeds. Errors keep
  // it armed so the normal backoff path can evaluate and retry later.
  if (result.triggerEval.fired && job.trigger?.once === true && result.status === "ok") {
    if (job.schedule.kind === "stream") {
      // Auto-disable is a source retirement just like an explicit disable. Rotate
      // in the same persisted result so queued sibling batches cannot gain admission.
      job.state.streamSourceIdentity = createCronStreamSourceIdentity();
    }
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
  }
}

/** Commits payload-script state only after the complete cron run succeeds. */
export function applyScriptRunResult(
  job: CronJob,
  result: { status: CronRunStatus; scriptStateChanged?: boolean; scriptState?: unknown },
): void {
  if (result.status === "ok" && result.scriptStateChanged === true) {
    // Trigger and payload scripts share frozen trigger.state. The payload's
    // final state wins only after trigger evaluation and payload execution succeed.
    job.state.triggerState = result.scriptState;
  }
}

/** Applies a quiet trigger tick without mutating normal run-history state. */
export function applyTriggerNoFireResult(
  state: CronServiceState,
  job: CronJob,
  result: { startedAt: number; endedAt: number; triggerEval: CronTriggerEvalOutcome },
  opts?: { scheduleMode?: "advance" | "preserve" },
): void {
  const previousNextRunAtMs = job.state.nextRunAtMs;
  const previousPacedNextRunAtMs = job.state.pacedNextRunAtMs;
  job.state.queuedAtMs = undefined;
  job.state.runningAtMs = undefined;
  job.updatedAtMs = result.endedAt;
  if (!result.triggerEval.busy) {
    // A non-firing evaluation is successful scheduler work, not a payload run;
    // reset error machinery while leaving lastRun/delivery history untouched.
    job.state.consecutiveErrors = 0;
    job.state.scheduleErrorCount = 0;
    job.state.lastFailureAlertAtMs = undefined;
    applyTriggerEvaluationState(job, result.triggerEval, result.endedAt);
  }
  if (opts?.scheduleMode === "preserve") {
    job.state.nextRunAtMs = previousNextRunAtMs;
    job.state.pacedNextRunAtMs = previousPacedNextRunAtMs;
    job.state.forcePreservedNextRunAtMs = previousNextRunAtMs;
    return;
  }
  job.state.pacedNextRunAtMs = undefined;
  job.state.forcePreservedNextRunAtMs = undefined;
  try {
    // Job-level computation keeps per-job cron staggering intact on quiet
    // ticks; raw schedule math would collapse watchers onto exact boundaries.
    const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
    const floorMs = Math.max(MIN_REFIRE_GAP_MS, resolveCronTriggerMinIntervalMs());
    // Quiet ticks still advance the schedule; the floor prevents scripts from
    // becoming a headless hot loop even when cron resolves inside the window.
    job.state.nextRunAtMs =
      naturalNext === undefined ? undefined : Math.max(naturalNext, result.endedAt + floorMs);
  } catch (err) {
    recordScheduleComputeError({ state, job, err });
  }
}

export function applyOutcomeToStoredJob(
  state: CronServiceState,
  result: TimedCronRunOutcome,
): CronJob | undefined {
  const store = state.store;
  if (!store) {
    tryFinishCronTaskRunWithoutHistory(state, result);
    return undefined;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job) {
    if (result.status === "ok" && result.triggerEval?.fired === false) {
      tryFinishCronTaskRunWithoutHistory(state, result);
      return undefined;
    }
    if (result.status === "ok") {
      // A manual/queued run may finish after the job was removed. Preserve the
      // successful run-history state without resurrecting the job in the store.
      applyJobResult(state, result.job, result);
      emitJobFinished(state, result.job, result, result.startedAt);
      state.deps.log.info(
        { jobId: result.jobId },
        "cron: finalized successful run after job was removed during execution",
      );
      return undefined;
    }
    state.deps.log.warn(
      { jobId: result.jobId },
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
    tryFinishCronTaskRunWithoutHistory(state, result);
    return undefined;
  }

  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    // Quiet trigger ticks intentionally emit no finished event: run history,
    // plugin hooks, and completion notifications represent payload runs only.
    applyTriggerNoFireResult(state, job, {
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      triggerEval: result.triggerEval,
    });
    job.state.startupCatchupAtMs = undefined;
    job.state.pacedNextRunAtMs = undefined;
    return undefined;
  }

  const shouldDelete = applyJobResult(state, job, result);
  applyTriggerRunResult(job, result);
  applyScriptRunResult(job, result);
  job.state.startupCatchupAtMs = undefined;

  emitJobFinished(state, job, result, result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    return job;
  }
  return undefined;
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
  runAtMs: number,
) {
  const event = {
    jobId: job.id,
    action: "finished",
    job,
    status: result.status,
    error: result.error,
    summary: result.summary,
    diagnostics: result.diagnostics,
    delivered: job.state.lastDelivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    delivery: result.delivery,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    ...(result.triggerEval?.fired ? { triggerFired: true } : {}),
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  } as const;
  tryFinishCronTaskRun(state, {
    taskRunId: result.taskRunId,
    job,
    event,
    errorClassification: result.errorClassification,
    ...(result.scriptStateChanged === true ? { scriptResult: result } : {}),
    ...(result.triggerEval ? { triggerEval: result.triggerEval } : {}),
  });
  emit(state, event);
}
