import type { CronJob, CronStoredJob } from "./types.js";

/** Remove scheduler-only state before a cron job crosses a public API boundary. */
export function toPublicCronJob(job: CronStoredJob): CronJob {
  const { toolsAllowProvenance: _toolsAllowProvenance, ...publicJob } = job;
  const state = { ...job.state };
  delete state.queuedAtMs;
  delete state.startupCatchupAtMs;
  delete state.pacedNextRunAtMs;
  delete state.forcePreservedNextRunAtMs;
  return { ...publicJob, state };
}
