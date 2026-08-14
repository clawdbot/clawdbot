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
// actionability, so a failure only counts while the job is still enabled.
// Disabled jobs keep their historical `lastRunStatus: "error"` for detail
// views, but a retired job must not be reported as an active problem.
export function isCronJobActiveFailure(job: CronJob): boolean {
  return job.enabled && resolveCronJobLastRunStatus(job) === "error";
}
