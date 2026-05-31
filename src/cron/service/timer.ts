import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import { readSessionEntry } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronConfig, CronRetryOn } from "../../config/types.cron.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  isRetryableHeartbeatBusySkipReason,
} from "../../infra/heartbeat-wake.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { resolveCronExecutionRetryHint } from "../retry-hint.js";
import {
  createCronRunDiagnosticsFromError,
  normalizeCronRunDiagnostics,
  summarizeCronRunDiagnostics,
} from "../run-diagnostics.js";
import { computeNextRunAtMs } from "../schedule.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronFailureNotificationDelivery,
  CronJob,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";
import { cleanupTimedOutCronAgentRun, createCronAgentWatchdog } from "./agent-watchdog.js";
import {
  abortErrorMessage,
  normalizeCronRunErrorText,
  timeoutErrorMessage,
} from "./execution-errors.js";
import {
  failureNotificationDeliveryFromJobState,
  maybeEmitFailureAlert,
  resolveFailureAlert,
} from "./failure-alerts.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  computeJobPreviousRunAtMs,
  computeJobNextRunAtMs,
  errorBackoffMs,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  recordScheduleComputeError,
  resolveJobErrorBackoffUntilMs,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import {
  resolveMainSessionCronRunSessionKey,
  tryCreateCronTaskRun,
  tryFinishCronTaskRun,
} from "./task-runs.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";

export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";
export { normalizeCronRunErrorText } from "./execution-errors.js";
export { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
export { wake } from "./wake.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;

const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 60_000;

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    job: CronJob;
    taskRunId?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    startedAt: number;
    endedAt: number;
  };

type StartupCatchupCandidate = {
  jobId: string;
  job: CronJob;
};

type StartupDeferredJob = {
  jobId: string;
  delayMs?: number;
};

type StartupCatchupPlan = {
  candidates: StartupCatchupCandidate[];
  deferredJobs: StartupDeferredJob[];
};

export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
): Promise<Awaited<ReturnType<typeof executeJobCore>>> {
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  if (typeof jobTimeoutMs !== "number") {
    return await executeJobCore(state, job);
  }

  const runAbortController = new AbortController();
  let timeoutReason: string | undefined;
  const timeoutMarker = Symbol("cron-timeout");
  let resolveTimeout: ((value: typeof timeoutMarker) => void) | undefined;
  const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
    resolveTimeout = resolve;
  });

  const deferTimeoutUntilExecutionStart =
    job.sessionTarget !== "main" && job.payload.kind === "agentTurn";
  const triggerTimeout = (reason: string) => {
    if (runAbortController.signal.aborted) {
      return;
    }
    timeoutReason = reason;
    runAbortController.abort(reason);
    resolveTimeout?.(timeoutMarker);
  };
  const watchdog = createCronAgentWatchdog({
    deferUntilRunner: deferTimeoutUntilExecutionStart,
    jobTimeoutMs,
    triggerTimeout,
  });
  const corePromise = executeJobCore(state, job, runAbortController.signal, {
    onExecutionStarted: deferTimeoutUntilExecutionStart ? watchdog.noteRunnerStarted : undefined,
    onExecutionPhase: deferTimeoutUntilExecutionStart ? watchdog.notePhase : undefined,
  });
  watchdog.start();
  void corePromise.catch((err) => {
    if (runAbortController.signal.aborted) {
      state.deps.log.warn(
        { jobId: job.id, err: String(err) },
        "cron: job core rejected after timeout abort",
      );
    }
  });
  try {
    const first = await Promise.race([corePromise, timeoutPromise]);
    if (first !== timeoutMarker) {
      return first;
    }
    const activeExecution = watchdog.activeExecution();
    await cleanupTimedOutCronAgentRun(state, job, jobTimeoutMs, activeExecution);
    const error = timeoutReason ?? timeoutErrorMessage(activeExecution);
    return {
      status: "error",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  } finally {
    watchdog.dispose();
  }
}

function resolveRunConcurrency(state: CronServiceState): number {
  const raw = state.deps.cronConfig?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}

function resolveMainSessionCronDeliveryContext(
  state: CronServiceState,
  job: CronJob,
): DeliveryContext | undefined {
  const targetSessionKey = job.sessionKey?.trim();
  if (!targetSessionKey) {
    return undefined;
  }
  const explicitAgentId = job.agentId?.trim();
  const agentId = normalizeAgentId(
    explicitAgentId || resolveAgentIdFromSessionKey(targetSessionKey),
  );
  const storePath = state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
  if (!storePath) {
    return undefined;
  }
  try {
    const sessionEntry = readSessionEntry(storePath, targetSessionKey) as SessionEntry | undefined;
    return deliveryContextFromSession(sessionEntry);
  } catch {
    return undefined;
  }
}

/** Default max retries for cron jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

type TransientCronRetryDecision = {
  retryable: boolean;
  consecutiveErrors: number;
  retryCategory?: CronRetryOn;
  backoffMs?: number;
  reason: "transient retry" | "max retries exhausted" | "permanent error";
};

function resolveCronNextRunWithLowerBound(params: {
  state: CronServiceState;
  job: CronJob;
  naturalNext: number | undefined;
  lowerBoundMs: number;
  context: "completion" | "error_backoff";
}): number | undefined {
  if (params.naturalNext === undefined) {
    params.state.deps.log.warn(
      {
        jobId: params.job.id,
        jobName: params.job.name,
        context: params.context,
      },
      "cron: next run unresolved; clearing schedule to avoid a refire loop",
    );
    return undefined;
  }
  return Math.max(params.naturalNext, params.lowerBoundMs);
}

function resolveRetryConfig(cronConfig?: CronConfig) {
  const retry = cronConfig?.retry;
  return {
    maxAttempts:
      typeof retry?.maxAttempts === "number" ? retry.maxAttempts : DEFAULT_MAX_TRANSIENT_RETRIES,
    backoffMs:
      Array.isArray(retry?.backoffMs) && retry.backoffMs.length > 0
        ? retry.backoffMs
        : DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, 3),
    retryOn: Array.isArray(retry?.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : undefined,
  };
}

function resolveTransientCronRetryDecision(params: {
  cronConfig?: CronConfig;
  error: string | undefined;
  lastErrorReason?: string;
  consecutiveErrors: number | undefined;
}): TransientCronRetryDecision {
  const retryConfig = resolveRetryConfig(params.cronConfig);
  const retryHint = resolveCronExecutionRetryHint(
    params.error,
    retryConfig.retryOn,
    params.lastErrorReason,
  );
  const consecutiveErrors = params.consecutiveErrors ?? 0;
  if (!retryHint.retryable) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "permanent error",
    };
  }
  if (consecutiveErrors > retryConfig.maxAttempts) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "max retries exhausted",
    };
  }
  return {
    retryable: true,
    consecutiveErrors,
    retryCategory: retryHint.category,
    backoffMs: errorBackoffMs(consecutiveErrors, retryConfig.backoffMs),
    reason: "transient retry",
  };
}

function resolveDeliveryState(params: {
  job: CronJob;
  runStatus: CronRunStatus;
  delivered?: boolean;
  error?: string;
  globalFailureDestination?: CronConfig["failureDestination"];
}): {
  delivered?: boolean;
  status: CronDeliveryStatus;
  error?: string;
  failureNotification: CronFailureNotificationDelivery;
} {
  const primaryDeliveryRequested = resolveCronDeliveryPlan(params.job).requested;
  const alternateFailureNotificationRequested =
    params.runStatus === "error" &&
    params.job.delivery?.bestEffort !== true &&
    resolveFailureDestination(params.job, params.globalFailureDestination) !== null;
  if (!primaryDeliveryRequested) {
    return {
      status: "not-requested",
      failureNotification: {
        status: alternateFailureNotificationRequested ? "unknown" : "not-requested",
      },
    };
  }
  if (params.runStatus === "error") {
    const failureNotification: CronFailureNotificationDelivery =
      alternateFailureNotificationRequested ? { status: "unknown" } : { status: "delivered" };
    if (params.delivered === true) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: alternateFailureNotificationRequested
          ? failureNotification
          : { delivered: true, status: "delivered" },
      };
    }
    if (params.delivered === false) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: alternateFailureNotificationRequested
          ? failureNotification
          : {
              delivered: false,
              status: "not-delivered",
              ...(params.error ? { error: params.error } : {}),
            },
      };
    }
    return {
      status: "unknown",
      error: params.error,
      failureNotification: { status: "unknown" },
    };
  }
  if (params.delivered === true) {
    return {
      delivered: true,
      status: "delivered",
      failureNotification: { status: "not-requested" },
    };
  }
  if (params.delivered === false) {
    return {
      delivered: false,
      status: "not-delivered",
      error: params.error,
      failureNotification: { status: "not-requested" },
    };
  }
  return { status: "unknown", failureNotification: { status: "not-requested" } };
}

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    error?: string;
    diagnostics?: CronRunOutcome["diagnostics"];
    delivered?: boolean;
    provider?: string;
    startedAt: number;
    endedAt: number;
  },
  opts?: {
    // Preserve recurring "every" anchors for manual force runs.
    preserveSchedule?: boolean;
  },
): boolean {
  const prevLastRunAtMs = job.state.lastRunAtMs;
  const computeNextWithPreservedLastRun = (nowMs: number) => {
    const saved = job.state.lastRunAtMs;
    job.state.lastRunAtMs = prevLastRunAtMs;
    try {
      return computeJobNextRunAtMs(job, nowMs);
    } finally {
      job.state.lastRunAtMs = saved;
    }
  };
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = result.status;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.state.lastDiagnostics = normalizeCronRunDiagnostics(result.diagnostics);
  job.state.lastDiagnosticSummary = summarizeCronRunDiagnostics(job.state.lastDiagnostics);
  job.state.lastErrorReason =
    result.status === "error" && typeof result.error === "string"
      ? (resolveFailoverReasonFromError(result.error, result.provider) ?? undefined)
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
    error: result.error,
    globalFailureDestination: state.deps.cronConfig?.failureDestination,
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
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    job.state.consecutiveSkipped = 0;
    maybeEmitFailureAlert(state, {
      job,
      alertConfig,
      status: "error",
      error: result.error,
      provider: result.provider,
      consecutiveCount: job.state.consecutiveErrors,
    });
  } else if (result.status === "skipped") {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = (job.state.consecutiveSkipped ?? 0) + 1;
    if (alertConfig?.includeSkipped) {
      maybeEmitFailureAlert(state, {
        job,
        alertConfig,
        status: "skipped",
        error: result.error,
        provider: result.provider,
        consecutiveCount: job.state.consecutiveSkipped,
      });
    } else {
      job.state.lastFailureAlertAtMs = undefined;
    }
  } else {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = 0;
    job.state.lastFailureAlertAtMs = undefined;
  }

  const shouldDelete =
    job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";

  if (!shouldDelete) {
    if (job.schedule.kind === "at") {
      if (result.status === "ok" || result.status === "skipped") {
        // One-shot done or skipped: disable to prevent tight-loop (#11452).
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (result.status === "error") {
        const retryDecision = resolveTransientCronRetryDecision({
          cronConfig: state.deps.cronConfig,
          error: result.error,
          lastErrorReason: job.state.lastErrorReason,
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
    } else if (result.status === "error" && isJobEnabled(job)) {
      const retryDecision = resolveTransientCronRetryDecision({
        cronConfig: state.deps.cronConfig,
        error: result.error,
        lastErrorReason: job.state.lastErrorReason,
        consecutiveErrors: job.state.consecutiveErrors,
      });
      let normalNext: number | undefined;
      let normalNextComputed = false;
      const computeNormalNext = () => {
        if (!normalNextComputed) {
          try {
            normalNext =
              opts?.preserveSchedule && job.schedule.kind === "every"
                ? computeNextWithPreservedLastRun(result.endedAt)
                : (retryDecision.retryable || previousConsecutiveErrors > 0) &&
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
      if (
        !opts?.preserveSchedule &&
        retryDecision.retryable &&
        retryDecision.backoffMs !== undefined
      ) {
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
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
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
    } else if (isJobEnabled(job)) {
      let naturalNext: number | undefined;
      try {
        naturalNext =
          opts?.preserveSchedule && job.schedule.kind === "every"
            ? computeNextWithPreservedLastRun(result.endedAt)
            : previousConsecutiveErrors > 0 && job.schedule.kind === "every"
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
        const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
        job.state.nextRunAtMs = resolveCronNextRunWithLowerBound({
          state,
          job,
          naturalNext,
          lowerBoundMs: minNext,
          context: "completion",
        });
      } else {
        job.state.nextRunAtMs = naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

function applyOutcomeToStoredJob(state: CronServiceState, result: TimedCronRunOutcome): void {
  clearCronJobActive(result.jobId);
  tryFinishCronTaskRun(state, result);
  const store = state.store;
  if (!store) {
    return;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job) {
    if (result.status === "ok") {
      applyJobResult(state, result.job, {
        status: result.status,
        error: result.error,
        diagnostics: result.diagnostics,
        delivered: result.delivered,
        provider: result.provider,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
      });
      emitJobFinished(state, result.job, result, result.startedAt);
      state.deps.log.info(
        { jobId: result.jobId },
        "cron: finalized successful run after job was removed during execution",
      );
      return;
    }
    state.deps.log.warn(
      { jobId: result.jobId },
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
    return;
  }

  const shouldDelete = applyJobResult(state, job, {
    status: result.status,
    error: result.error,
    diagnostics: result.diagnostics,
    delivered: result.delivered,
    provider: result.provider,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  });

  emitJobFinished(state, job, result, result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    emit(state, { jobId: job.id, action: "removed", job });
  }
}

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    const jobCount = state.store?.jobs.length ?? 0;
    const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
    const withNextRun =
      state.store?.jobs.filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs))
        .length ?? 0;
    if (enabledCount > 0) {
      armRunningRecheckTimer(state);
      state.deps.log.debug(
        { jobCount, enabledCount, withNextRun, delayMs: MAX_TIMER_DELAY_MS },
        "cron: timer armed for maintenance recheck",
      );
      return;
    }
    state.deps.log.debug(
      { jobCount, enabledCount, withNextRun },
      "cron: armTimer skipped - no jobs with nextRunAtMs",
    );
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Floor: when the next wake time is in the past (delay === 0), enforce a
  // minimum delay to prevent a tight setTimeout(0) loop.  This can happen
  // when a job has a stuck runningAtMs marker and a past-due nextRunAtMs:
  // findDueJobs skips the job (blocked by runningAtMs), while
  // recomputeNextRunsForMaintenance intentionally does not advance the
  // past-due nextRunAtMs (per #13992).  The finally block in onTimer then
  // re-invokes armTimer with delay === 0, creating an infinite hot-loop
  // that saturates the event loop and fills the log file to its size cap.
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);
  // Intentionally avoid an `async` timer callback:
  // Vitest's fake-timer helpers can await async callbacks, which would block
  // tests that simulate long-running jobs. Runtime behavior is unchanged.
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    "cron: timer armed",
  );
}

function armRunningRecheckTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, MAX_TIMER_DELAY_MS);
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    // Re-arm the timer so the scheduler keeps ticking even when a job is
    // still executing.  Without this, a long-running job (e.g. an agentTurn
    // exceeding MAX_TIMER_DELAY_MS) causes the clamped 60 s timer to fire
    // while `running` is true.  The early return then leaves no timer set,
    // silently killing the scheduler until the next gateway restart.
    //
    // We use MAX_TIMER_DELAY_MS as a fixed re-check interval to avoid a
    // zero-delay hot-loop when past-due jobs are waiting for the current
    // execution to finish.
    // See: https://github.com/openclaw/openclaw/issues/12025
    armRunningRecheckTimer(state);
    return;
  }
  state.running = true;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const dueCheckNow = state.deps.nowMs();
      const due = collectRunnableJobs(state, dueCheckNow);

      if (due.length === 0) {
        // Use maintenance-only recompute to avoid advancing past-due nextRunAtMs
        // values without execution. This prevents jobs from being silently skipped
        // when the timer wakes up but findDueJobs returns empty (see #13992).
        const changed = recomputeNextRunsForMaintenance(state, {
          recomputeExpired: true,
          nowMs: dueCheckNow,
        });
        if (changed) {
          await persist(state);
        }
        return [];
      }

      const now = state.deps.nowMs();
      for (const job of due) {
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
      }
      await persist(state);

      return due.map((j) => ({
        id: j.id,
        job: j,
      }));
    });

    const runDueJob = async (params: {
      id: string;
      job: CronJob;
    }): Promise<TimedCronRunOutcome> => {
      const { id, job } = params;
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      markCronJobActive(job.id);
      emit(state, { jobId: job.id, action: "started", job, runAtMs: startedAt });
      const jobTimeoutMs = resolveCronJobTimeoutMs(job);
      const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });

      try {
        const result = await executeJobCoreWithTimeout(state, job);
        return {
          jobId: id,
          job,
          taskRunId,
          ...result,
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      } catch (err) {
        const errorText = normalizeCronRunErrorText(err);
        state.deps.log.warn(
          { jobId: id, jobName: job.name, timeoutMs: jobTimeoutMs ?? null },
          `cron: job failed: ${errorText}`,
        );
        return {
          jobId: id,
          job,
          taskRunId,
          status: "error",
          error: errorText,
          diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, {
            nowMs: state.deps.nowMs,
          }),
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      }
    };

    const concurrency = Math.min(resolveRunConcurrency(state), Math.max(1, dueJobs.length));
    const results: (TimedCronRunOutcome | undefined)[] = Array.from({ length: dueJobs.length });
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= dueJobs.length) {
          return;
        }
        const due = dueJobs[index];
        if (!due) {
          return;
        }
        results[index] = await runDueJob(due);
      }
    });
    await Promise.all(workers);

    const completedResults: TimedCronRunOutcome[] = results.filter(
      (entry): entry is TimedCronRunOutcome => entry !== undefined,
    );

    if (completedResults.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        for (const result of completedResults) {
          applyOutcomeToStoredJob(state, result);
        }

        // Use maintenance-only recompute to avoid advancing past-due
        // nextRunAtMs values that became due between findDueJobs and this
        // locked block.  The full recomputeNextRuns would silently skip
        // those jobs (advancing nextRunAtMs without execution), causing
        // daily cron schedules to jump 48 h instead of 24 h (#17852).
        recomputeNextRunsForMaintenance(state);
        await persist(state);
      });
    }
  } finally {
    // Piggyback session reaper on timer tick (self-throttled to every 5 min).
    // Placed in `finally` so the reaper runs even when a long-running job keeps
    // `state.running` true across multiple timer ticks — the early return at the
    // top of onTimer would otherwise skip the reaper indefinitely.
    const storePaths = new Set<string>();
    if (state.deps.resolveSessionStorePath) {
      const defaultAgentId = state.deps.defaultAgentId ?? DEFAULT_AGENT_ID;
      if (state.store?.jobs?.length) {
        for (const job of state.store.jobs) {
          const agentId =
            typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
          storePaths.add(state.deps.resolveSessionStorePath(agentId));
        }
      } else {
        storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
      }
    } else if (state.deps.sessionStorePath) {
      storePaths.add(state.deps.sessionStorePath);
    }

    if (storePaths.size > 0) {
      const nowMs = state.deps.nowMs();
      for (const storePath of storePaths) {
        try {
          await sweepCronRunSessions({
            cronConfig: state.deps.cronConfig,
            sessionStorePath: storePath,
            nowMs,
            log: state.deps.log,
          });
        } catch (err) {
          state.deps.log.warn({ err: String(err), storePath }, "cron: session reaper sweep failed");
        }
      }
    }

    state.running = false;
    armTimer(state);
  }
}

function isRunnableJob(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
  skipJobIds?: ReadonlySet<string>;
  skipAtIfAlreadyRan?: boolean;
  allowCronMissedRunByLastRun?: boolean;
}): boolean {
  const { job, nowMs } = params;
  if (!job.state) {
    job.state = {};
  }
  if (!isJobEnabled(job)) {
    return false;
  }
  if (params.skipJobIds?.has(job.id)) {
    return false;
  }
  if (typeof job.state.runningAtMs === "number") {
    return false;
  }
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && job.state.lastStatus) {
    // One-shot with terminal status: skip unless it's a transient-error retry.
    // Retries have nextRunAtMs > lastRunAtMs (scheduled after the failed run) (#24355).
    // ok/skipped or error-without-retry always skip (#13845).
    const lastRun = job.state.lastRunAtMs;
    const nextRun = job.state.nextRunAtMs;
    if (
      job.state.lastStatus === "error" &&
      isJobEnabled(job) &&
      typeof nextRun === "number" &&
      typeof lastRun === "number" &&
      nextRun > lastRun
    ) {
      return nowMs >= nextRun;
    }
    return false;
  }
  const next = job.state.nextRunAtMs;
  if (isErrorBackoffPending(params.state, job, nowMs)) {
    // Error retry windows are anchored at run end; persisted start-based
    // retry timestamps from older state must not bypass active backoff.
    return false;
  }
  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    return true;
  }
  if (!params.allowCronMissedRunByLastRun || job.schedule.kind !== "cron") {
    return false;
  }
  let previousRunAtMs: number | undefined;
  try {
    previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
  } catch {
    return false;
  }
  if (typeof previousRunAtMs !== "number" || !Number.isFinite(previousRunAtMs)) {
    return false;
  }
  const lastRunAtMs = job.state.lastRunAtMs;
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    // Only replay a "missed slot" when there is concrete run history.
    return false;
  }
  return previousRunAtMs > lastRunAtMs;
}

function isErrorBackoffPending(state: CronServiceState, job: CronJob, nowMs: number): boolean {
  if (job.schedule.kind === "at" || job.state.lastStatus !== "error") {
    return false;
  }
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(
    job,
    state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  );
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs;
}

function collectRunnableJobs(
  state: CronServiceState,
  nowMs: number,
  opts?: {
    skipJobIds?: ReadonlySet<string>;
    skipAtIfAlreadyRan?: boolean;
    allowCronMissedRunByLastRun?: boolean;
  },
): CronJob[] {
  if (!state.store) {
    return [];
  }
  return state.store.jobs.filter((job) =>
    isRunnableJob({
      state,
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
      allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun,
    }),
  );
}

function deferPendingBackoffMissedCronSlots(
  state: CronServiceState,
  nowMs: number,
  opts?: { skipJobIds?: ReadonlySet<string> },
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    if (
      !isJobEnabled(job) ||
      job.schedule.kind !== "cron" ||
      opts?.skipJobIds?.has(job.id) ||
      typeof job.state.runningAtMs === "number"
    ) {
      continue;
    }
    const backoffUntilMs = resolveJobErrorBackoffUntilMs(
      job,
      state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
    );
    if (backoffUntilMs === undefined || nowMs >= backoffUntilMs) {
      continue;
    }
    let previousRunAtMs: number | undefined;
    try {
      previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
    } catch {
      continue;
    }
    const lastRunAtMs = job.state.lastRunAtMs;
    if (
      typeof previousRunAtMs !== "number" ||
      !Number.isFinite(previousRunAtMs) ||
      typeof lastRunAtMs !== "number" ||
      !Number.isFinite(lastRunAtMs) ||
      previousRunAtMs <= lastRunAtMs
    ) {
      continue;
    }
    if (job.state.nextRunAtMs !== backoffUntilMs) {
      job.state.nextRunAtMs = backoffUntilMs;
      changed = true;
    }
  }
  return changed;
}

export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentTurnJobs?: boolean },
) {
  const plan = await planStartupCatchup(state, opts);
  if (plan.candidates.length === 0 && plan.deferredJobs.length === 0) {
    return;
  }

  const outcomes = await executeStartupCatchupPlan(state, plan);
  await applyStartupCatchupOutcomes(state, plan, outcomes);
}

async function planStartupCatchup(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentTurnJobs?: boolean },
): Promise<StartupCatchupPlan> {
  const maxImmediate = Math.max(
    0,
    state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  return locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return { candidates: [], deferredJobs: [] };
    }

    const now = state.deps.nowMs();
    const deferredBackoffMissedSlot = deferPendingBackoffMissedCronSlots(state, now, {
      skipJobIds: opts?.skipJobIds,
    });
    const missed = collectRunnableJobs(state, now, {
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: true,
      allowCronMissedRunByLastRun: true,
    });
    if (missed.length === 0) {
      if (deferredBackoffMissedSlot) {
        await persist(state);
      }
      return { candidates: [], deferredJobs: [] };
    }
    const sorted = missed.toSorted(
      (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
    );
    const deferredAgentJobs = opts?.deferAgentTurnJobs
      ? sorted.filter((job) => job.payload.kind === "agentTurn")
      : [];
    const startupEligible = opts?.deferAgentTurnJobs
      ? sorted.filter((job) => job.payload.kind !== "agentTurn")
      : sorted;
    const startupCandidates = startupEligible.slice(0, maxImmediate);
    const deferredOverflow = startupEligible.slice(maxImmediate);
    const deferredAgentDelayMs = Math.max(
      0,
      state.deps.startupDeferredMissedAgentJobDelayMs ??
        DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
    );
    const deferred: StartupDeferredJob[] = [
      ...deferredOverflow.map((job) => ({ jobId: job.id })),
      ...deferredAgentJobs.map((job) => ({ jobId: job.id, delayMs: deferredAgentDelayMs })),
    ];
    if (deferred.length > 0) {
      state.deps.log.info(
        {
          immediateCount: startupCandidates.length,
          deferredCount: deferred.length,
          totalMissed: missed.length,
        },
        "cron: staggering missed jobs to prevent gateway overload",
      );
    }
    if (deferredAgentJobs.length > 0) {
      state.deps.log.info(
        {
          count: deferredAgentJobs.length,
          jobIds: deferredAgentJobs.map((job) => job.id),
          delayMs: deferredAgentDelayMs,
        },
        "cron: deferring missed agent jobs until after gateway startup",
      );
    }
    if (startupCandidates.length > 0) {
      state.deps.log.info(
        { count: startupCandidates.length, jobIds: startupCandidates.map((j) => j.id) },
        "cron: running missed jobs after restart",
      );
    }
    for (const job of startupCandidates) {
      job.state.runningAtMs = now;
      job.state.lastError = undefined;
    }
    await persist(state);

    return {
      candidates: startupCandidates.map((job) => ({ jobId: job.id, job })),
      deferredJobs: deferred,
    };
  });
}

async function executeStartupCatchupPlan(
  state: CronServiceState,
  plan: StartupCatchupPlan,
): Promise<TimedCronRunOutcome[]> {
  const outcomes: TimedCronRunOutcome[] = [];
  for (const candidate of plan.candidates) {
    outcomes.push(await runStartupCatchupCandidate(state, candidate));
  }
  return outcomes;
}

async function runStartupCatchupCandidate(
  state: CronServiceState,
  candidate: StartupCatchupCandidate,
): Promise<TimedCronRunOutcome> {
  const startedAt = state.deps.nowMs();
  const taskRunId = tryCreateCronTaskRun({
    state,
    job: candidate.job,
    startedAt,
  });
  emit(state, {
    jobId: candidate.job.id,
    action: "started",
    job: candidate.job,
    runAtMs: startedAt,
  });
  try {
    const result = await executeJobCoreWithTimeout(state, candidate.job);
    return {
      jobId: candidate.jobId,
      job: candidate.job,
      taskRunId,
      status: result.status,
      error: result.error,
      summary: result.summary,
      diagnostics: result.diagnostics,
      delivered: result.delivered,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      startedAt,
      endedAt: state.deps.nowMs(),
    };
  } catch (err) {
    return {
      jobId: candidate.jobId,
      job: candidate.job,
      taskRunId,
      status: "error",
      error: normalizeCronRunErrorText(err),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", normalizeCronRunErrorText(err), {
        nowMs: state.deps.nowMs,
      }),
      startedAt,
      endedAt: state.deps.nowMs(),
    };
  }
}

async function applyStartupCatchupOutcomes(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: TimedCronRunOutcome[],
): Promise<void> {
  const staggerMs = Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
  await locked(state, async () => {
    // Startup catch-up runs during service bootstrap, before the timer loop is
    // armed. Reuse the in-memory store instead of forcing a second reload.
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return;
    }

    for (const result of outcomes) {
      applyOutcomeToStoredJob(state, result);
    }

    if (plan.deferredJobs.length > 0) {
      const baseNow = state.deps.nowMs();
      let offset = staggerMs;
      for (const deferred of plan.deferredJobs) {
        const jobId = deferred.jobId;
        const job = state.store.jobs.find((entry) => entry.id === jobId);
        if (!job || !isJobEnabled(job)) {
          continue;
        }
        if (typeof deferred.delayMs === "number") {
          job.state.nextRunAtMs = baseNow + deferred.delayMs + offset - staggerMs;
          offset += staggerMs;
          continue;
        }
        job.state.nextRunAtMs = baseNow + offset;
        offset += staggerMs;
      }
    }

    // Preserve any new past-due nextRunAtMs values that became due while
    // startup catch-up was running. They should execute on a future tick
    // instead of being silently advanced. Future repair is disabled here so
    // startup overflow deferrals survive until their staggered catch-up tick.
    recomputeNextRunsForMaintenance(state, { repairFutureCronNextRunAtMs: false });
    await persist(state);
  });
}

export async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
  options?: {
    onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
    onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  },
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: abortErrorMessage(abortSignal),
  });
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  if (job.sessionTarget === "main") {
    return await executeMainSessionCronJob(state, job, abortSignal, waitWithAbort);
  }

  return await executeDetachedCronJob(state, job, abortSignal, resolveAbortError, options);
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  waitWithAbort: (ms: number) => Promise<void>,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    }
> {
  const text = resolveJobPayloadTextForMain(job);
  if (!text) {
    const kind = job.payload.kind;
    return {
      status: "skipped",
      error:
        kind === "systemEvent"
          ? "main job requires non-empty systemEvent text"
          : 'main job requires payload.kind="systemEvent"',
    };
  }
  const cronStartedAt =
    typeof job.state.runningAtMs === "number" ? job.state.runningAtMs : state.deps.nowMs();
  const cronRunSessionKey = resolveMainSessionCronRunSessionKey(job, cronStartedAt);
  const deliveryContext = resolveMainSessionCronDeliveryContext(state, job);
  state.deps.enqueueSystemEvent(text, {
    agentId: job.agentId,
    sessionKey: cronRunSessionKey,
    contextKey: `cron:${job.id}`,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    const reason = `cron:${job.id}`;
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    let heartbeatResult: HeartbeatRunResult;
    for (;;) {
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      heartbeatResult = await state.deps.runHeartbeatOnce({
        source: "cron",
        intent: "immediate",
        reason,
        agentId: job.agentId,
        sessionKey: cronRunSessionKey,
        heartbeat: { target: "last" },
      });
      if (
        heartbeatResult.status !== "skipped" ||
        !isRetryableHeartbeatBusySkipReason(heartbeatResult.reason)
      ) {
        break;
      }
      if (heartbeatResult.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS) {
        // The active cron marker blocks direct wake-now until this job returns.
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        if (abortSignal?.aborted) {
          return { status: "error", error: timeoutErrorMessage() };
        }
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      await waitWithAbort(retryDelayMs);
    }

    if (heartbeatResult.status === "ran") {
      return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
    }
    if (heartbeatResult.status === "skipped") {
      return {
        status: "skipped",
        error: heartbeatResult.reason,
        summary: text,
        sessionKey: cronRunSessionKey,
      };
    }
    return {
      status: "error",
      error: heartbeatResult.reason,
      summary: text,
      sessionKey: cronRunSessionKey,
    };
  }

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }
  state.deps.requestHeartbeat({
    source: "cron",
    intent: job.wakeMode === "now" ? "immediate" : "event",
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: cronRunSessionKey,
    heartbeat: { target: "last" },
  });
  return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  resolveAbortError: () => { status: "error"; error: string },
  options?: {
    onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
    onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  },
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    }
> {
  if (job.payload.kind !== "agentTurn") {
    const error = "isolated job requires payload.kind=agentTurn";
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (abortSignal?.aborted) {
    const aborted = resolveAbortError();
    return {
      ...aborted,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", aborted.error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
  });

  if (abortSignal?.aborted) {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

/**
 * Execute a job. This version is used by the `run` command and other
 * places that need the full execution with state updates.
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  _nowMs: number,
  _opts: { forced: boolean },
) {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  markCronJobActive(job.id);
  emit(state, { jobId: job.id, action: "started", job, runAtMs: startedAt });

  let coreResult: {
    status: CronRunStatus;
    delivered?: boolean;
    delivery?: CronDeliveryTrace;
  } & CronRunOutcome &
    CronRunTelemetry;
  try {
    coreResult = await executeJobCoreWithTimeout(state, job);
  } catch (err) {
    coreResult = { status: "error", error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    diagnostics: coreResult.diagnostics,
    delivered: coreResult.delivered,
    provider: coreResult.provider,
    startedAt,
    endedAt,
  });

  emitJobFinished(state, job, coreResult, startedAt);

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed", job });
  }
  clearCronJobActive(job.id);
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    delivered?: boolean;
    delivery?: CronDeliveryTrace;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  emit(state, {
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
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  });
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
