import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import { resolvePacedNextRunAtMs } from "../pacing.js";
import { normalizeCronRunDiagnostics, summarizeCronRunDiagnostics } from "../run-diagnostics.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { computeNextRunAtMs } from "../schedule.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { maybeAutoDisableCronJobAfterRunFailure } from "./auto-disable.js";
import {
  finalizeCronFailureNotifications,
  maybeEmitFailureAlert,
  resolveFailureAlert,
} from "./failure-alerts.js";
import {
  computeJobNextRunAtMs,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  errorBackoffMs,
  isJobEnabled,
  recordScheduleComputeError,
} from "./jobs-scheduling.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import {
  type CronJobRunResult,
  type CronTriggerEvalOutcome,
  MIN_REFIRE_GAP_MS,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { emitCronOutcomeEventForJob, recordCronOutcomeForJob } from "./timer-outcome-events.js";
import {
  applyTriggerEvaluationState,
  applyTriggerRunResult,
  resolveCronNextRunWithLowerBound,
  resolveDeliveryState,
  resolveDisabledHeartbeatOneShotRetryDecision,
  resolveNextRunAtMsOrDisable,
  resolveTransientCronRetryDecision,
  shouldRetryDisabledHeartbeatOneShot,
} from "./timer-trigger.js";

type CronScheduleOwnership = "current" | "stale";
type CronTriggerOwnership = "current" | "stale";

/** Checks both the admitted schedule and edits that may have returned to its original value. */
export function resolveCronRunScheduleOwnership(params: {
  admittedJob: CronJob;
  currentJob: CronJob;
  activeJobMarker?: CronActiveJobMarker;
}): CronScheduleOwnership {
  return params.activeJobMarker?.scheduleMutated === true ||
    !cronSchedulingInputsEqual(params.admittedJob, params.currentJob)
    ? "stale"
    : "current";
}

/** Keeps trigger state owned by the exact script/once definition that evaluated it. */
export function resolveCronRunTriggerOwnership(params: {
  admittedJob: CronJob;
  currentJob: CronJob;
  activeJobMarker?: CronActiveJobMarker;
}): CronTriggerOwnership {
  return params.activeJobMarker?.triggerMutated === true ||
    params.admittedJob.trigger?.script !== params.currentJob.trigger?.script ||
    params.admittedJob.trigger?.once !== params.currentJob.trigger?.once
    ? "stale"
    : "current";
}

function assignNextRunAtMs(
  params: Parameters<typeof resolveNextRunAtMsOrDisable>[0],
): number | undefined {
  const nextRunAtMs = resolveNextRunAtMsOrDisable(params);
  params.job.state.nextRunAtMs = nextRunAtMs;
  return nextRunAtMs;
}

/** Applies run outcome state, delivery state, backoff/next-run scheduling, and delete-after-run policy. */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: CronJobRunResult,
  opts?: {
    // Manual force runs update outcome state but are out-of-band for cadence.
    scheduleMode?: "advance" | "preserve";
    // An in-flight edit owns all future schedule and one-shot policy.
    scheduleOwnership?: CronScheduleOwnership;
    // Lane and admission waits must not transfer a pre-deadline manual run's ownership.
    scheduleOwnershipAtMs?: number;
    // Startup replay restores alert cooldown bookkeeping without redelivery.
    replayFailureAlertAtMs?: number;
    // Originating run-history row; forwarded into the alert callback for exact settlement.
    taskRunId?: string;
    deferredNotifications?: DeferredCronNotifications;
  },
): boolean {
  const previousScheduleState = {
    enabled: job.enabled,
    nextRunAtMs: job.state.nextRunAtMs,
    pacedNextRunAtMs: job.state.pacedNextRunAtMs,
    forcePreservedNextRunAtMs: job.state.forcePreservedNextRunAtMs,
  };
  job.state.queuedAtMs = undefined;
  job.state.runningAtMs = undefined;
  job.state.pacedNextRunAtMs = undefined;
  job.state.forcePreservedNextRunAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = result.status;
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
  const deliveryState =
    result.deliveryState ??
    resolveDeliveryState({
      job,
      runStatus: result.status,
      delivery: result.delivery,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
      error: result.deliveryError ?? result.error,
    });
  job.state.lastDelivered = deliveryState.delivered;
  job.state.lastDeliveryStatus = deliveryState.status;
  job.state.lastDeliveryError =
    deliveryState.status === "not-delivered" && deliveryState.error
      ? deliveryState.error
      : undefined;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "not-requested";
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable; skipped runs use a
  // separate counter so opt-in skip alerts do not affect retry behavior.
  const previousConsecutiveErrors = job.state.consecutiveErrors ?? 0;
  const alertConfig = resolveFailureAlert(state, job);
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    job.state.consecutiveSkipped = 0;
  } else if (result.status === "skipped") {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = (job.state.consecutiveSkipped ?? 0) + 1;
    if (alertConfig?.includeSkipped) {
      maybeEmitFailureAlert(state, {
        job,
        alertConfig,
        status: "skipped",
        error: result.error,
        runAtMs: result.startedAt,
        consecutiveCount: job.state.consecutiveSkipped,
        ...(opts?.replayFailureAlertAtMs !== undefined
          ? { delivery: "record-only" as const, occurredAtMs: opts.replayFailureAlertAtMs }
          : {}),
        taskRunId: opts?.taskRunId,
        deferredNotifications: opts?.deferredNotifications,
      });
    } else {
      job.state.lastFailureAlertAtMs = undefined;
    }
  } else {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = 0;
    job.state.lastFailureAlertAtMs = undefined;
  }

  // An operator force-run borrows a future at-schedule; it cannot consume,
  // disable, or retry that scheduled occurrence. On-exit watchers also use
  // force, but their terminal callback owns and must retire the watched job.
  const preserveOneShotSchedule =
    opts?.scheduleMode === "preserve" &&
    job.schedule.kind === "at" &&
    previousScheduleState.nextRunAtMs !== undefined &&
    previousScheduleState.nextRunAtMs > (opts.scheduleOwnershipAtMs ?? result.startedAt);
  const ownsSchedule = opts?.scheduleOwnership !== "stale";
  const isOneShotSchedule = job.schedule.kind === "at" || job.schedule.kind === "on-exit";
  const completionStatus =
    result.completionStatus ??
    resolveAdmittedCronCompletionStatus(job, result.status, deliveryState.status);
  const shouldDelete =
    ownsSchedule &&
    isOneShotSchedule &&
    !preserveOneShotSchedule &&
    job.deleteAfterRun === true &&
    completionStatus === "succeeded";
  let autoDisableNotificationOwnsFailure = false;
  const finish = () => {
    finalizeCronFailureNotifications(state, {
      job,
      alertConfig,
      result,
      completionFailed: completionStatus === "failed",
      autoDisableNotificationOwnsFailure,
      replayFailureAlertAtMs: opts?.replayFailureAlertAtMs,
      taskRunId: opts?.taskRunId,
      deferredNotifications: opts?.deferredNotifications,
    });
    return shouldDelete;
  };

  if (!ownsSchedule) {
    // The completed invocation still owns its outcome, but the latest durable
    // operator edit owns enablement, cadence, pacing, and future retry policy.
    job.enabled = previousScheduleState.enabled;
    job.state.nextRunAtMs = previousScheduleState.nextRunAtMs;
    job.state.pacedNextRunAtMs = previousScheduleState.pacedNextRunAtMs;
    job.state.forcePreservedNextRunAtMs = previousScheduleState.forcePreservedNextRunAtMs;
  } else if (!shouldDelete) {
    if (preserveOneShotSchedule) {
      job.state.nextRunAtMs = previousScheduleState.nextRunAtMs;
      job.state.pacedNextRunAtMs = previousScheduleState.pacedNextRunAtMs;
      job.state.forcePreservedNextRunAtMs = previousScheduleState.nextRunAtMs;
    } else if (job.schedule.kind === "at") {
      if (shouldRetryDisabledHeartbeatOneShot(job, result)) {
        const retryDecision = resolveDisabledHeartbeatOneShotRetryDecision({
          cronConfig: state.deps.cronConfig,
          consecutiveSkipped: job.state.consecutiveSkipped,
        });
        if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
          job.enabled = true;
          if (
            assignNextRunAtMs({
              state,
              job,
              candidate: result.endedAt + retryDecision.backoffMs,
              deferredNotifications: opts?.deferredNotifications,
            }) !== undefined
          ) {
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
          }
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
      } else if (result.status === "ok" || result.status === "skipped") {
        // One-shot done or skipped: disable to prevent tight-loop (#11452).
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (result.status === "error") {
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
          if (
            assignNextRunAtMs({
              state,
              job,
              candidate: result.endedAt + retryDecision.backoffMs,
              deferredNotifications: opts?.deferredNotifications,
            }) !== undefined
          ) {
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
          }
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
    } else if (opts?.scheduleMode === "preserve") {
      // Forced recurring runs do not consume, replace, or repair a scheduled
      // slot. Preserve the timestamp and its paced provenance as one unit.
      job.state.nextRunAtMs = previousScheduleState.nextRunAtMs;
      job.state.pacedNextRunAtMs = previousScheduleState.pacedNextRunAtMs;
      job.state.forcePreservedNextRunAtMs = previousScheduleState.nextRunAtMs;
    } else if (
      result.status === "error" &&
      isJobEnabled(job) &&
      maybeAutoDisableCronJobAfterRunFailure({
        state,
        job,
        atMs: result.endedAt,
        deferredNotifications: opts?.deferredNotifications,
      })
    ) {
      autoDisableNotificationOwnsFailure = true;
      // Keep this after the ownership and immediate-preserve gates: those paths
      // restore schedule state and would otherwise silently undo the disable.
      state.deps.log.error(
        {
          jobId: job.id,
          name: job.name,
          consecutiveErrors: job.state.consecutiveErrors,
          error: result.error,
        },
        "cron: auto-disabled job after consecutive run failures",
      );
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
            recordScheduleComputeError({
              state,
              job,
              err,
              deferredNotifications: opts?.deferredNotifications,
            });
          }
          normalNextComputed = true;
        }
        return normalNext;
      };
      if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
        normalNext = computeNormalNext();
        if (normalNext === undefined) {
          // Preserve the unresolved-cron guard (#66019): do not synthesize a
          // retry when the schedule cannot produce a next scheduled slot.
        } else {
          const retryNextRunAtMs = assignNextRunAtMs({
            state,
            job,
            candidate: result.endedAt + retryDecision.backoffMs,
            deferredNotifications: opts?.deferredNotifications,
          });
          if (retryNextRunAtMs === undefined) {
            return finish();
          }
          if (retryNextRunAtMs < normalNext) {
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
            return finish();
          }
        }
      }
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(
        job.state.consecutiveErrors ?? 1,
        DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
      normalNext = computeNormalNext();
      if (normalNext === undefined && job.schedule.kind === "every") {
        assignNextRunAtMs({
          state,
          job,
          candidate: undefined,
          deferredNotifications: opts?.deferredNotifications,
        });
        return finish();
      }
      const backoffNext = assignNextRunAtMs({
        state,
        job,
        candidate: result.endedAt + backoff,
        deferredNotifications: opts?.deferredNotifications,
      });
      if (backoffNext === undefined) {
        return finish();
      }
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        job.schedule.kind === "cron"
          ? resolveCronNextRunWithLowerBound({
              state,
              job,
              naturalNext: normalNext,
              lowerBoundMs: backoffNext,
              deferredNotifications: opts?.deferredNotifications,
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
      const nextRunAtMs = assignNextRunAtMs({
        state,
        job,
        candidate: job.trigger
          ? Math.max(
              pacedNextRunAtMs ?? Number.NaN,
              result.endedAt + Math.max(MIN_REFIRE_GAP_MS, resolveCronTriggerMinIntervalMs()),
            )
          : pacedNextRunAtMs,
        deferredNotifications: opts?.deferredNotifications,
      });
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
        recordScheduleComputeError({
          state,
          job,
          err,
          deferredNotifications: opts?.deferredNotifications,
        });
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
          deferredNotifications: opts?.deferredNotifications,
        });
      } else {
        const triggerNext =
          naturalNext !== undefined && job.trigger
            ? Math.max(naturalNext, result.endedAt + resolveCronTriggerMinIntervalMs())
            : naturalNext;
        job.state.nextRunAtMs = triggerNext;
        if (triggerNext !== undefined || job.schedule.kind === "every") {
          assignNextRunAtMs({
            state,
            job,
            candidate: triggerNext,
            deferredNotifications: opts?.deferredNotifications,
          });
        }
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return finish();
}

/** Commits payload-script state only after the complete cron run succeeds. */
export function applyScriptRunResult(
  job: CronJob,
  result: { status: CronRunStatus; scriptStateChanged?: boolean; scriptState?: unknown },
  opts?: { triggerOwnership?: CronTriggerOwnership },
): void {
  if (
    opts?.triggerOwnership !== "stale" &&
    result.status === "ok" &&
    result.scriptStateChanged === true
  ) {
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
  opts?: {
    scheduleMode?: "advance" | "immediate-preserve" | "stale-preserve";
    triggerOwnership?: CronTriggerOwnership;
    deferredNotifications?: DeferredCronNotifications;
  },
): void {
  const previousNextRunAtMs = job.state.nextRunAtMs;
  const previousPacedNextRunAtMs = job.state.pacedNextRunAtMs;
  const previousForcePreservedNextRunAtMs = job.state.forcePreservedNextRunAtMs;
  job.state.queuedAtMs = undefined;
  job.state.runningAtMs = undefined;
  job.updatedAtMs = result.endedAt;
  if (!result.triggerEval.busy && opts?.triggerOwnership !== "stale") {
    // A non-firing evaluation is successful scheduler work, not a payload run;
    // reset error machinery while leaving lastRun/delivery history untouched.
    job.state.consecutiveErrors = 0;
    job.state.scheduleErrorCount = 0;
    job.state.lastFailureAlertAtMs = undefined;
    applyTriggerEvaluationState(job, result.triggerEval, result.endedAt);
  }
  if (opts?.scheduleMode === "immediate-preserve" || opts?.scheduleMode === "stale-preserve") {
    job.state.nextRunAtMs = previousNextRunAtMs;
    job.state.pacedNextRunAtMs = previousPacedNextRunAtMs;
    // A stale wake preserves the operator's complete schedule; only an actual
    // force run may create the marker that exempts its slot from repair.
    job.state.forcePreservedNextRunAtMs =
      opts.scheduleMode === "immediate-preserve"
        ? previousNextRunAtMs
        : previousForcePreservedNextRunAtMs;
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
    job.state.nextRunAtMs = naturalNext;
    if (naturalNext !== undefined || job.schedule.kind === "every") {
      assignNextRunAtMs({
        state,
        job,
        candidate:
          naturalNext === undefined ? undefined : Math.max(naturalNext, result.endedAt + floorMs),
        deferredNotifications: opts?.deferredNotifications,
      });
    }
  } catch (err) {
    recordScheduleComputeError({
      state,
      job,
      err,
      deferredNotifications: opts?.deferredNotifications,
    });
  }
}

export function applyOutcomeToStoredJob(
  state: CronServiceState,
  result: TimedCronRunOutcome,
  opts?: { deferredNotifications?: DeferredCronNotifications },
): CronJob | undefined {
  const store = state.store;
  if (!store) {
    tryFinishCronTaskRunWithoutHistory(state, result);
    return undefined;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job || result.activeJobMarker?.jobRemoved === true) {
    if (result.status === "ok" && result.triggerEval?.fired === false) {
      tryFinishCronTaskRunWithoutHistory(state, result);
      return undefined;
    }
    // A run may finish after its job disappears; finalize the admitted job
    // snapshot so operator history survives without reviving the stored job.
    applyJobResult(state, result.job, result, {
      scheduleOwnership: "stale",
      taskRunId: result.taskRunId,
      deferredNotifications: opts?.deferredNotifications,
    });
    emitCronOutcomeForJob(state, result.job, result);
    state.deps.log.info(
      { jobId: result.jobId, status: result.status },
      "cron: finalized run after job was removed during execution",
    );
    return undefined;
  }

  if (applyOutcomeToAuthoritativeJob(state, job, result, opts)) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    return job;
  }
  return undefined;
}

/** Applies one outcome to a row already re-read under the runtime write transaction. */
export function applyOutcomeToAuthoritativeJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
  opts?: { deferredNotifications?: DeferredCronNotifications; emit?: boolean },
): boolean {
  const scheduleOwnership = resolveCronRunScheduleOwnership({
    admittedJob: result.job,
    currentJob: job,
    activeJobMarker: result.activeJobMarker,
  });
  const triggerOwnership = resolveCronRunTriggerOwnership({
    admittedJob: result.job,
    currentJob: job,
    activeJobMarker: result.activeJobMarker,
  });

  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    // Quiet trigger ticks intentionally emit no finished event: run history,
    // plugin hooks, and completion notifications represent payload runs only.
    applyTriggerNoFireResult(
      state,
      job,
      {
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        triggerEval: result.triggerEval,
      },
      {
        scheduleMode: scheduleOwnership === "stale" ? "stale-preserve" : "advance",
        triggerOwnership,
        deferredNotifications: opts?.deferredNotifications,
      },
    );
    job.state.startupCatchupAtMs = undefined;
    if (scheduleOwnership === "current") {
      // Quiet ticks consume their old pacing slot. Only an in-flight schedule
      // edit owns a replacement override that must survive finalization.
      job.state.pacedNextRunAtMs = undefined;
    }
    return false;
  }

  const shouldDelete = applyJobResult(state, job, result, {
    scheduleOwnership,
    taskRunId: result.taskRunId,
    deferredNotifications: opts?.deferredNotifications,
  });
  applyTriggerRunResult(job, result, { scheduleOwnership, triggerOwnership });
  applyScriptRunResult(job, result, { triggerOwnership });
  job.state.startupCatchupAtMs = undefined;

  if (opts?.emit !== false) {
    emitCronOutcomeForJob(state, job, result);
  }

  return shouldDelete;
}

/** Records a terminal task/event fact before the fallible runtime-row commit. */
function emitCronOutcomeForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): void {
  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    return;
  }
  recordCronOutcomeForJob(state, job, result);
  emitCronOutcomeEventForJob(state, job, result);
}
