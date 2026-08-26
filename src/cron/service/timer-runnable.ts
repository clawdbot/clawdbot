import { parseAbsoluteTimeMs } from "../parse.js";
import type { CronJob } from "../types.js";
import {
  computeJobPreviousRunAtOrBeforeMs,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  resolveJobErrorBackoffUntilMs,
  resolveJobLastRunStatus,
} from "./jobs-scheduling.js";
import type { CronServiceState } from "./state.js";
import { isScheduledTerminalOneShotRetry } from "./timer-trigger.js";

/**
 * Reports whether a cron job's last completed run is older than its previous
 * effective slot, which is how restart catch-up detects a missed run once
 * nextRunAtMs has already advanced past it.
 */
export function hasMissedCronSlotSinceLastRun(job: CronJob, nowMs: number): boolean {
  const lastRunAtMs = job.state.lastRunAtMs;
  // Only replay a "missed slot" when there is concrete run history.
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    return false;
  }
  let previousRunAtMs: number | undefined;
  try {
    previousRunAtMs = computeJobPreviousRunAtOrBeforeMs(job, nowMs);
  } catch {
    return false;
  }
  if (
    typeof previousRunAtMs !== "number" ||
    !Number.isFinite(previousRunAtMs) ||
    previousRunAtMs <= lastRunAtMs
  ) {
    return false;
  }
  // Slots computed from freshly edited scheduling inputs never existed before
  // those inputs took effect, so they are not missed runs. lastRunAtMs belongs
  // to the retired schedule and would otherwise stay stale forever (#91944).
  const activatedAtMs = job.state.scheduleActivatedAtMs;
  if (typeof activatedAtMs !== "number" || !Number.isFinite(activatedAtMs)) {
    return true;
  }
  return previousRunAtMs > activatedAtMs;
}

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
  const next = job.state.nextRunAtMs;
  // Ordinary ticks cannot recover a missed cron slot before a future wake.
  // Keep their dominant no-due path ahead of run-history normalization.
  if (!params.allowCronMissedRunByLastRun && hasScheduledNextRunAtMs(next) && nowMs < next) {
    return false;
  }
  const lastRunStatus = resolveJobLastRunStatus(job);
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && lastRunStatus) {
    const lastRun = job.state.lastRunAtMs;
    const nextRun = job.state.nextRunAtMs;
    // Terminal history belongs to the old occurrence. A matching newer
    // one-shot still owns its scheduled catch-up after a restart.
    if (
      typeof lastRun === "number" &&
      typeof nextRun === "number" &&
      nextRun > lastRun &&
      parseAbsoluteTimeMs(job.schedule.at) === nextRun
    ) {
      return nowMs >= nextRun;
    }
    // Other terminal one-shots stay consumed unless their owner explicitly
    // scheduled a failed/skipped retry (#24355, #91775).
    if (isScheduledTerminalOneShotRetry(job, lastRunStatus, lastRun, nextRun)) {
      return typeof nextRun === "number" && nowMs >= nextRun;
    }
    return false;
  }
  if (isErrorBackoffPending(job, nowMs, lastRunStatus)) {
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
  return hasMissedCronSlotSinceLastRun(job, nowMs);
}

function isErrorBackoffPending(
  job: CronJob,
  nowMs: number,
  lastRunStatus: ReturnType<typeof resolveJobLastRunStatus>,
): boolean {
  if (job.schedule.kind === "at" || lastRunStatus !== "error") {
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
