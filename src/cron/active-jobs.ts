import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobIds: Set<string>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // the in-flight job set process-global so duplicate-run guards share state.
  return resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
  }));
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.add(jobId);
}

/** Clears the active marker when a cron run exits or is abandoned. */
export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.delete(jobId);
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return getCronActiveJobState().activeJobIds.has(jobId);
}

/** Returns whether any cron run is active in this process. */
export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobIds.size > 0;
}

/** Clears process-global cron active-job state between tests. */
export function resetCronActiveJobsForTests() {
  getCronActiveJobState().activeJobIds.clear();
}
