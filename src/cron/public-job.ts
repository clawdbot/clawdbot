import type { CronJob } from "./types.js";

/** Remove scheduler-only state before a cron job crosses a public API boundary. */
export function toPublicCronJob(job: CronJob): CronJob {
  const state = { ...job.state };
  delete state.queuedAtMs;
  delete state.startupCatchupAtMs;
  delete state.pacedNextRunAtMs;
  delete state.forcePreservedNextRunAtMs;
  return { ...job, state };
}
