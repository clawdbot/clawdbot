import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobIds: Set<string>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  return resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
  }));
}

export function markCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.add(jobId);
}

export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.delete(jobId);
}

export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return getCronActiveJobState().activeJobIds.has(jobId);
}

export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobIds.size > 0;
}

export function resetCronActiveJobsForTests() {
  getCronActiveJobState().activeJobIds.clear();
}
