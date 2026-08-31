import type { CronJob, CronStoredJob } from "./types.js";

/** Remove scheduler-only state before a cron job crosses a public API boundary. */
export function toPublicCronJob(job: CronStoredJob): CronJob {
  const {
    createdActor: _createdActor,
    toolsAllowProvenance: _toolsAllowProvenance,
    toolsAllowExecTarget: _toolsAllowExecTarget,
    toolsAllowExecTargetRequirement: _toolsAllowExecTargetRequirement,
    runtimeAuthority: _runtimeAuthority,
    runtimeAuthorityRecoveryRequired: _runtimeAuthorityRecoveryRequired,
    ...publicJob
  } = job;
  const state = { ...job.state };
  delete state.queuedAtMs;
  delete state.startupCatchupAtMs;
  delete state.pacedNextRunAtMs;
  delete state.forcePreservedNextRunAtMs;
  return { ...publicJob, state };
}
