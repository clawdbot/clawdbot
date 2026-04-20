import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import type { CronConfig, CronRetryOn } from "../../config/types.cron.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { createCronExecutionId } from "../run-id.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type {
  CronDeliveryStatus,
  CronJob,
  CronMessageChannel,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";
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
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import { DEFAULT_JOB_TIMEOUT_MS, resolveCronJobTimeoutMs } from "./timeout-policy.js";

export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";

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
const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000; // 1 hour

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
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

type StartupCatchupPlan = {
  candidates: StartupCatchupCandidate[];
  deferredJobIds: string[];
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
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      executeJobCore(state, job, runAbortController.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          runAbortController.abort(timeoutErrorMessage());
          reject(new Error(timeoutErrorMessage()));
        }, jobTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveRunConcurrency(state: CronServiceState): number {
  const raw = state.deps.cronConfig?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}
function timeoutErrorMessage(): string {
  return "cron: job execution timed out";
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}

export function normalizeCronRunErrorText(err: unknown): string {
  if (isAbortError(err)) {
    return timeoutErrorMessage();
  }
  if (typeof err === "string") {
    return err === `Error: ${timeoutErrorMessage()}` ? timeoutErrorMessage() : err;
  }
  return String(err);
}

function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const runId = createCronExecutionId(params.job.id, params.startedAt);
  try {
    createRunningTaskRun({
      runtime: "cron",
      sourceId: params.job.id,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: params.job.sessionKey,
      agentId: params.job.agentId,
      runId,
      label: params.job.name,
      task: params.job.name || params.job.id,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
    });
    return runId;
  } catch (error) {
    params.state.deps.log.warn(
      { jobId: params.job.id, error },
      "cron: failed to create task ledger record",
    );
    return undefined;
  }
}

function tryFinishCronTaskRun(
  state: CronServiceState,
  result: Pick<TimedCronRunOutcome, "taskRunId" | "status" | "error" | "endedAt" | "summary">,
): void {
  if (!result.taskRunId) {
    return;
  }
  try {
    if (result.status === "ok" || result.status === "skipped") {
      completeTaskRunByRunId({
        runId: result.taskRunId,
        runtime: "cron",
        endedAt: result.endedAt,
        lastEventAt: result.endedAt,
        terminalSummary: result.summary ?? undefined,
      });
      return;
    }
    failTaskRunByRunId({
      runId: result.taskRunId,
      runtime: "cron",
      status:
        normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
      endedAt: result.endedAt,
      lastEventAt: result.endedAt,
      error: result.status === "error" ? normalizeCronRunErrorText(result.error) : undefined,
      terminalSummary: result.summary ?? undefined,
    });
  } catch (error) {
    state.deps.log.warn(
      { runId: result.taskRunId, jobStatus: result.status, error },
      "cron: failed to update task ledger record",
    );
  }
}
/** Default max retries for one-shot jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

const TRANSIENT_PATTERNS: Record<string, RegExp> = {
  rate_limit:
    /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare|tokens per day)/i,
  overloaded:
    /\b529\b|\boverloaded(?:_error)?\b|high demand|temporar(?:ily|y) overloaded|capacity exceeded/i,
  network: /(network|econnreset|econnrefused|fetch failed|socket)/i,
  timeout: /(timeout|etimedout)/i,
  server_error: /\b5\d{2}\b/,
};

function isTransientCronError(error: string | undefined, retryOn?: CronRetryOn[]): boolean {
  if (!error || typeof error !== "string") {
    return false;
  }
  const keys = retryOn?.length ? retryOn : (Object.keys(TRANSIENT_PATTERNS) as CronRetryOn[]);
  return keys.some((k) => TRANSIENT_PATTERNS[k]?.test(error));
}

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

function resolveDeliveryStatus(params: { job: CronJob; delivered?: boolean }): CronDeliveryStatus {
  if (params.delivered === true) {
    return "delivered";
  }
  if (params.delivered === false) {
    return "not-delivered";
  }
  return resolveCronDeliveryPlan(params.job).requested ? "unknown" : "not-requested";
}

function normalizeCronMessageChannel(input: unknown): CronMessageChannel | undefined {
  const channel = normalizeOptionalLowercaseString(input);
  return channel ? (channel as CronMessageChannel) : undefined;
}

function normalizeTo(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const to = input.trim();
  return to ? to : undefined;
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 0 ? floored : fallback;
}

function resolveFailureAlert(
  state: CronServiceState,
  job: CronJob,
): {
  after: number;
  cooldownMs: number;
  channel: CronMessageChannel;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
} | null {
  const globalConfig = state.deps.cronConfig?.failureAlert;
  const jobConfig = job.failureAlert === false ? undefined : job.failureAlert;

  if (job.failureAlert === false) {
    return null;
  }
  if (!jobConfig && globalConfig?.enabled !== true) {
    return null;
  }

  const mode = jobConfig?.mode ?? globalConfig?.mode;
  const explicitTo = normalizeTo(jobConfig?.to);

  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel:
      normalizeCronMessageChannel(jobConfig?.channel) ??
      normalizeCronMessageChannel(job.delivery?.channel) ??
      "last",
    to: mode === "webhook" ? explicitTo : (explicitTo ?? normalizeTo(job.delivery?.to)),
    mode,
    accountId: jobConfig?.accountId ?? globalConfig?.accountId,
  };
}

function emitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    error?: string;
    consecutiveErrors: number;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
  },
) {
  const safeJobName = params.job.name || params.job.id;
  const truncatedError = (params.error?.trim() || "unknown error").slice(0, 200);
  const text = [
    `Cron job "${safeJobName}" failed ${params.consecutiveErrors} times`,
    `Last error: ${truncatedError}`,
  ].join("\n");

  if (state.deps.sendCronFailureAlert) {
    void state.deps
      .sendCronFailureAlert({
        job: params.job,
        text,
        channel: params.channel,
        to: params.to,
        mode: params.mode,
        accountId: params.accountId,
      })
      .catch((err) => {
        state.deps.log.warn(
          { jobId: params.job.id, err: String(err) },
          "cron: failure alert delivery failed",
        );
      });
    return;
  }

  state.deps.enqueueSystemEvent(text, { agentId: params.job.agentId });
  if (params.job.wakeMode === "now") {
    state.deps.requestHeartbeatNow({ reason: `cron:${params.job.id}:failure-alert` });
  }
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
    delivered?: boolean;
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
  job.state.lastErrorReason =
    result.status === "error" && typeof result.error === "string"
      ? (resolveFailoverReasonFromError(result.error) ?? undefined)
      : undefined;
  job.state.lastDelivered = result.delivered;
  const deliveryStatus = resolveDeliveryStatus({ job, delivered: result.delivered });
  job.state.lastDeliveryStatus = deliveryStatus;
  job.state.lastDeliveryError =
    deliveryStatus === "not-delivered" && result.error ? result.error : undefined;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    const alertConfig = resolveFailureAlert(state, job);
    if (alertConfig && job.state.consecutiveErrors >= alertConfig.after) {
      const isBestEffort = job.delivery?.bestEffort === true;
      if (!isBestEffort) {
        const now = state.deps.nowMs();
        const lastAlert = job.state.lastFailureAlertAtMs;
        const inCooldown =
          typeof lastAlert === "number" && now - lastAlert < Math.max(0, alertConfig.cooldownMs);
        if (!inCooldown) {
          emitFailureAlert(state, {
            job,
            error: result.error,
            consecutiveErrors: job.state.consecutiveErrors,
            channel: alertConfig.channel,
            to: alertConfig.to,
            mode: alertConfig.mode,
            accountId: alertConfig.accountId,
          });
          job.state.lastFailureAlertAtMs = now;
        }
      }
    }
  } else {
    job.state.consecutiveErrors = 0;
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
        const retryConfig = resolveRetryConfig(state.deps.cronConfig);
        const transient = isTransientCronError(result.error, retryConfig.retryOn);
        // consecutiveErrors is always set to ≥1 by the increment block above.
        const consecutive = job.state.consecutiveErrors;
        if (transient && consecutive <= retryConfig.maxAttempts) {
          // Schedule retry with backoff (#24355).
          const backoff = errorBackoffMs(consecutive, retryConfig.backoffMs);
          job.state.nextRunAtMs = result.endedAt + backoff;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: consecutive,
              backoffMs: backoff,
              nextRunAtMs: job.state.nextRunAtMs,
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
              consecutiveErrors: consecutive,
              error: result.error,
              reason: transient ? "max retries exhausted" : "permanent error",
            },
            "cron: disabling one-shot job after error",
          );
        }
      }
    } else if (result.status === "error" && isJobEnabled(job)) {
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      let normalNext: number | undefined;
      try {
        normalNext =
          opts?.preserveSchedule && job.schedule.kind === "every"
            ? computeNextWithPreservedLastRun(result.endedAt)
            : computeJobNextRunAtMs(job, result.endedAt);
      } catch (err) {
        // If the schedule expression/timezone throws (croner edge cases),
        // record the schedule error (auto-disables after repeated failures)
        // and fall back to backoff-only schedule so the state update is not lost.
        recordScheduleComputeError({ state, job, err });
      }
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
    state.deps.log.warn(
      { jobId: result.jobId },
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
    return;
  }

  const shouldDelete = applyJobResult(state, job, {
    status: result.status,
    error: result.error,
    delivered: result.delivered,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  });

  emitJobFinished(state, job, result, result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
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
      emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
      const jobTimeoutMs = resolveCronJobTimeoutMs(job);
      const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });

      try {
        const result = await executeJobCoreWithTimeout(state, job);
        return {
          jobId: id,
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
          taskRunId,
          status: "error",
          error: errorText,
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
  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    return true;
  }
  if (hasScheduledNextRunAtMs(next) && next > nowMs && isErrorBackoffPending(job, nowMs)) {
    // Respect active retry backoff windows on restart, but allow missed-slot
    // replay once the backoff window has elapsed.
    return false;
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

function isErrorBackoffPending(job: CronJob, nowMs: number): boolean {
  if (job.schedule.kind === "at" || job.state.lastStatus !== "error") {
    return false;
  }
  const lastRunAtMs = job.state.lastRunAtMs;
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    return false;
  }
  const consecutiveErrorsRaw = job.state.consecutiveErrors;
  const consecutiveErrors =
    typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw)
      ? Math.max(1, Math.floor(consecutiveErrorsRaw))
      : 1;
  return nowMs < lastRunAtMs + errorBackoffMs(consecutiveErrors);
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
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
      allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun,
    }),
  );
}

export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string> },
) {
  const plan = await planStartupCatchup(state, opts);
  if (plan.candidates.length === 0 && plan.deferredJobIds.length === 0) {
    return;
  }

  const outcomes = await executeStartupCatchupPlan(state, plan);
  await applyStartupCatchupOutcomes(state, plan, outcomes);
}

async function planStartupCatchup(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string> },
): Promise<StartupCatchupPlan> {
  const maxImmediate = Math.max(
    0,
    state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  return locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return { candidates: [], deferredJobIds: [] };
    }

    const now = state.deps.nowMs();
    const missed = collectRunnableJobs(state, now, {
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: true,
      allowCronMissedRunByLastRun: true,
    });
    if (missed.length === 0) {
      return { candidates: [], deferredJobIds: [] };
    }
    const sorted = missed.toSorted(
      (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
    );
    const startupCandidates = sorted.slice(0, maxImmediate);
    const deferred = sorted.slice(maxImmediate);
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
      deferredJobIds: deferred.map((job) => job.id),
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
  emit(state, { jobId: candidate.job.id, action: "started", runAtMs: startedAt });
  try {
    const result = await executeJobCoreWithTimeout(state, candidate.job);
    return {
      jobId: candidate.jobId,
      taskRunId,
      status: result.status,
      error: result.error,
      summary: result.summary,
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
      taskRunId,
      status: "error",
      error: normalizeCronRunErrorText(err),
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

    if (plan.deferredJobIds.length > 0) {
      const baseNow = state.deps.nowMs();
      let offset = staggerMs;
      for (const jobId of plan.deferredJobIds) {
        const job = state.store.jobs.find((entry) => entry.id === jobId);
        if (!job || !isJobEnabled(job)) {
          continue;
        }
        job.state.nextRunAtMs = baseNow + offset;
        offset += staggerMs;
      }
    }

    // Preserve any new past-due nextRunAtMs values that became due while
    // startup catch-up was running. They should execute on a future tick
    // instead of being silently advanced.
    recomputeNextRunsForMaintenance(state);
    await persist(state);
  });
}

export async function runDueJobs(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const due = collectRunnableJobs(state, now);
  for (const job of due) {
    await executeJob(state, job, now, { forced: false });
  }
}

export async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
): Promise<
  CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: timeoutErrorMessage(),
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

  return await executeDetachedCronJob(state, job, abortSignal, resolveAbortError);
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  waitWithAbort: (ms: number) => Promise<void>,
): Promise<
  CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
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
  const targetMainSessionKey = job.sessionKey;
  state.deps.enqueueSystemEvent(text, {
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
    contextKey: `cron:${job.id}`,
  });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    const reason = `cron:${job.id}`;
    const isRecurringJob = job.schedule.kind !== "at";
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    let heartbeatResult: HeartbeatRunResult;
    for (;;) {
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      heartbeatResult = await state.deps.runHeartbeatOnce({
        reason,
        agentId: job.agentId,
        sessionKey: targetMainSessionKey,
        heartbeat: { target: "last" },
      });
      if (heartbeatResult.status !== "skipped" || heartbeatResult.reason !== "requests-in-flight") {
        break;
      }
      if (isRecurringJob) {
        // Recurring main-session cron jobs should not hold the cron lane open
        // while the main lane is busy, or their measured duration starts to
        // reflect queue wait instead of cron bookkeeping (#58833).
        state.deps.requestHeartbeatNow({
          reason,
          agentId: job.agentId,
          sessionKey: targetMainSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text };
      }
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        if (abortSignal?.aborted) {
          return { status: "error", error: timeoutErrorMessage() };
        }
        state.deps.requestHeartbeatNow({
          reason,
          agentId: job.agentId,
          sessionKey: targetMainSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text };
      }
      await waitWithAbort(retryDelayMs);
    }

    if (heartbeatResult.status === "ran") {
      return { status: "ok", summary: text };
    }
    if (heartbeatResult.status === "skipped") {
      return { status: "skipped", error: heartbeatResult.reason, summary: text };
    }
    return { status: "error", error: heartbeatResult.reason, summary: text };
  }

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }
  state.deps.requestHeartbeatNow({
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
    heartbeat: { target: "last" },
  });
  return { status: "ok", summary: text };
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  resolveAbortError: () => { status: "error"; error: string },
): Promise<
  CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
> {
  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
  });

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
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
  emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

  let coreResult: {
    status: CronRunStatus;
    delivered?: boolean;
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
    delivered: coreResult.delivered,
    startedAt,
    endedAt,
  });

  emitJobFinished(state, job, coreResult, startedAt);

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
  clearCronJobActive(job.id);
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    delivered?: boolean;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  emit(state, {
    jobId: job.id,
    action: "finished",
    status: result.status,
    error: result.error,
    summary: result.summary,
    delivered: result.delivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
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

export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  state.deps.enqueueSystemEvent(text);
  if (opts.mode === "now") {
    state.deps.requestHeartbeatNow({ reason: "wake" });
  }
  return { ok: true } as const;
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
