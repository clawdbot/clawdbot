// Control UI module implements cron status behavior.
import type { CronJob, CronRunStatus } from "../api/types.ts";

type CronJobLastRunStatus = CronRunStatus | "unknown";

export function resolveCronJobLastRunStatus(job: CronJob): CronJobLastRunStatus {
  return job.state?.lastRunStatus ?? job.state?.lastStatus ?? "unknown";
}

// The gateway intentionally leaves nextRunAtMs past-due while a run executes
// (it only advances on the outcome), so "overdue" surfaces must not flag a
// job that is actively running. runningAtMs is the recorded fact for that.
export function isCronJobRunning(job: CronJob): boolean {
  const runningAtMs = job.state?.runningAtMs;
  return typeof runningAtMs === "number" && Number.isFinite(runningAtMs);
}

// "Failed cron" surfaces (cron page, sidebar attention chips) track current
// actionability, so a failure only counts while the job is still enabled —
// with one exception: auto-disabled jobs are the ESCALATED failure state, not
// an operator pause, so hiding them would drop the problem from every failure
// surface exactly when it became permanent. Operator-paused jobs keep their
// historical `lastRunStatus: "error"` for detail views without being flagged.
export function isCronJobActiveFailure(job: CronJob): boolean {
  if (job.state?.autoDisabled) {
    return true;
  }
  return job.enabled && resolveCronJobLastRunStatus(job) === "error";
}
