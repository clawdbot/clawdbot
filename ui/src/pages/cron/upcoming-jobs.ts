/**
 * Pure helpers for the upcoming panel: separates time-scheduled jobs (at/every/cron)
 * from event-driven ones (on-exit/stream) so "upcoming" never mixes scheduled ETAs
 * with non-time triggers.
 */
import type { CronJob } from "../../api/types.ts";
import { formatRelativeTimestamp, formatMs } from "../../lib/format.ts";

/** Whether a schedule kind is time-driven (has a meaningful nextRunAtMs). */
function isTimeSchedule(kind: string): boolean {
  return kind === "at" || kind === "every" || kind === "cron";
}

/** Group of time-scheduled jobs with computed next-run ETAs. */
export interface UpcomingScheduledJob {
  job: CronJob;
  /** Formatted absolute timestamp, e.g. "Mon, Sep 1, 9:00 AM" */
  absTime: string;
  /** Formatted relative label, e.g. "in 2 hours" */
  relTime: string;
}

/** Group of event-driven jobs (on-exit / stream). */
export interface UpcomingEventJob {
  job: CronJob;
}

/** Separates jobs into time-scheduled and event-driven. Time-scheduled jobs
 * are sorted by nextRunAtMs ascending. */
export function groupUpcomingJobs(
  jobs: CronJob[],
  nowMs = Date.now(),
): { scheduled: UpcomingScheduledJob[]; event: UpcomingEventJob[] } {
  const scheduled: UpcomingScheduledJob[] = [];
  const event: UpcomingEventJob[] = [];

  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    if (!isTimeSchedule(job.schedule.kind)) {
      event.push({ job });
      continue;
    }
    const nextRunAtMs = job.state?.nextRunAtMs;
    if (typeof nextRunAtMs !== "number" || !Number.isFinite(nextRunAtMs)) {
      continue;
    }
    scheduled.push({
      job,
      absTime: formatMs(nextRunAtMs),
      relTime: formatRelativeTimestamp(nextRunAtMs, {
        // Show "in X" for future times, "X ago" for past
        suffix: nextRunAtMs > nowMs,
      }),
    });
  }

  scheduled.sort((a, b) => {
    const aMs = a.job.state?.nextRunAtMs ?? Infinity;
    const bMs = b.job.state?.nextRunAtMs ?? Infinity;
    return aMs - bMs;
  });

  return { scheduled, event };
}
