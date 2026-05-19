import type { CronJob } from "../types.js";
import {
  computeJobPreviousRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  resolveJobErrorBackoffUntilMs,
  resolveJobLastRunStatus,
} from "./jobs.js";
import type { CronServiceState } from "./state.js";
import { isScheduledTerminalOneShotRetry } from "./timer-trigger.js";

export function isRunnableJob(params: {
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
  if (hasActiveCronRun(job)) {
    return false;
  }
  const lastRunStatus = resolveJobLastRunStatus(job);
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && lastRunStatus) {
    if (!job.state.lastRunWasManual) {
      // One-shot with terminal status: skip unless it has an explicit retry
      // scheduled after the failed/skipped run (#24355, #91775). Manual runs
      // fall through so a `cron run` does not suppress the scheduled fire (#83538).
      const lastRun = job.state.lastRunAtMs;
      const nextRun = job.state.nextRunAtMs;
      if (isScheduledTerminalOneShotRetry(job, lastRunStatus, lastRun, nextRun)) {
        return typeof nextRun === "number" && nowMs >= nextRun;
      }
      return false;
    }
  }
  const next = job.state.nextRunAtMs;
  if (isErrorBackoffPending(params.state, job, nowMs)) {
    // Error retry windows are anchored at run end; persisted start-based
    // retry timestamps from older state must not bypass active backoff.
    return false;
  }
  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    const lastRunAtMs = job.state.lastRunAtMs;
    // Startup loads persisted state before maintenance recompute. Suppress a
    // completed stale slot, but still replay a newer slot due by restart time.
    const alreadyCompletedDueCronSlot =
      params.allowCronMissedRunByLastRun &&
      job.schedule.kind === "cron" &&
      (lastRunStatus === "ok" || lastRunStatus === "skipped") &&
      typeof lastRunAtMs === "number" &&
      Number.isFinite(lastRunAtMs) &&
      lastRunAtMs >= next;
    if (!alreadyCompletedDueCronSlot) {
      return true;
    }
    let latestRunAtMs: number | undefined;
    try {
      latestRunAtMs = computeJobPreviousRunAtOrBeforeMs(job, nowMs);
    } catch {
      return false;
    }
    return typeof latestRunAtMs === "number" && latestRunAtMs > lastRunAtMs;
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

function isErrorBackoffPending(_state: CronServiceState, job: CronJob, nowMs: number): boolean {
  if (job.schedule.kind === "at" || resolveJobLastRunStatus(job) !== "error") {
    return false;
  }
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs;
}

export function collectRunnableJobs(
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
