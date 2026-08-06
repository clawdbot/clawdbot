/** Tracks in-process cron executions so schedulers and wake paths avoid duplicate runs. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobs: Map<string, CronActiveJobMarker>;
  generation: number;
  nextToken: number;
  emptyWaiters: Set<() => void>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

export type CronActiveJobMarker = {
  jobId: string;
  generation: number;
  token: number;
  scheduleMutated?: true;
  triggerMutated?: true;
  jobRemoved?: true;
  preserveAcrossGenerationAdvance?: boolean;
};

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // the in-flight job set process-global so duplicate-run guards share state.
  const state = resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobs: new Map<string, CronActiveJobMarker>(),
    generation: 0,
    nextToken: 1,
    emptyWaiters: new Set<() => void>(),
  }));
  state.generation ??= 0;
  state.nextToken ??= 1;
  state.activeJobs ??= new Map<string, CronActiveJobMarker>();
  state.emptyWaiters ??= new Set<() => void>();
  return state;
}

function getActiveCronJobCountForGeneration(state: CronActiveJobState) {
  let active = 0;
  for (const marker of state.activeJobs.values()) {
    if (isMarkerActiveInGeneration(marker, state.generation)) {
      active += 1;
    }
  }
  return active;
}

function isMarkerActiveInGeneration(marker: CronActiveJobMarker, generation: number) {
  return marker.generation === generation || marker.preserveAcrossGenerationAdvance === true;
}

function notifyActiveCronJobWaitersIfEmpty(state: CronActiveJobState) {
  if (getActiveCronJobCountForGeneration(state) > 0) {
    return;
  }
  for (const resolve of state.emptyWaiters) {
    resolve();
  }
  state.emptyWaiters.clear();
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(
  jobId: string,
  opts?: { preserveAcrossGenerationAdvance?: boolean },
): CronActiveJobMarker | undefined {
  if (!jobId) {
    return undefined;
  }
  const state = getCronActiveJobState();
  const token = state.nextToken;
  state.nextToken += 1;
  const marker: CronActiveJobMarker = {
    jobId,
    generation: state.generation,
    token,
    ...(opts?.preserveAcrossGenerationAdvance ? { preserveAcrossGenerationAdvance: true } : {}),
  };
  state.activeJobs.set(jobId, marker);
  return marker;
}

/** Clears the active marker when a cron run exits or is abandoned. */
export function clearCronJobActive(jobId: string, marker?: CronActiveJobMarker) {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  const activeMarker = state.activeJobs.get(jobId);
  if (
    activeMarker &&
    (!marker || (marker.jobId === jobId && marker.token === activeMarker.token))
  ) {
    state.activeJobs.delete(jobId);
  }
  notifyActiveCronJobWaitersIfEmpty(state);
}

/** Records a durable schedule edit against the exact run that was active for it. */
export function noteActiveCronJobScheduleMutation(jobId: string): void {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  const marker = state.activeJobs.get(jobId);
  if (marker && isMarkerActiveInGeneration(marker, state.generation)) {
    // Keep mutation history on the admitted run: A→B→A has the original
    // schedule value but still belongs to the operator's newer edit.
    marker.scheduleMutated = true;
  }
}

/** Records a durable trigger edit against the exact run that evaluated it. */
export function noteActiveCronJobTriggerMutation(jobId: string): void {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  const marker = state.activeJobs.get(jobId);
  if (marker && isMarkerActiveInGeneration(marker, state.generation)) {
    // A→B→A restores the script but cannot return ownership of the new
    // trigger state to an evaluation admitted before either durable edit.
    marker.triggerMutated = true;
  }
}

/** Retires the admitted job identity after its deletion becomes durable. */
export function noteActiveCronJobRemoval(jobId: string): void {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  const marker = state.activeJobs.get(jobId);
  if (marker && isMarkerActiveInGeneration(marker, state.generation)) {
    // A reused ID names a new job, not a reschedule of the old invocation.
    // Keep its marker until completion so duplicate-run guards remain intact.
    marker.scheduleMutated = true;
    marker.jobRemoved = true;
  }
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  const state = getCronActiveJobState();
  const marker = state.activeJobs.get(jobId);
  return marker ? isMarkerActiveInGeneration(marker, state.generation) : false;
}

export function isCronActiveJobMarkerCurrent(marker: CronActiveJobMarker | undefined) {
  if (!marker) {
    return true;
  }
  const state = getCronActiveJobState();
  const activeMarker = state.activeJobs.get(marker.jobId);
  return (
    activeMarker?.token === marker.token && isMarkerActiveInGeneration(marker, state.generation)
  );
}

/** Returns whether any cron run is active in this process. */
export function hasActiveCronJobs() {
  return getActiveCronJobCountForGeneration(getCronActiveJobState()) > 0;
}

/**
 * Ignore only the caller's own marker. Unrelated runs must still block its wake,
 * because cron jobs may execute concurrently.
 */
export function hasActiveCronJobsExceptMarker(markerToIgnore: CronActiveJobMarker) {
  const state = getCronActiveJobState();
  for (const marker of state.activeJobs.values()) {
    const isIgnoredMarker =
      marker.jobId === markerToIgnore.jobId && marker.token === markerToIgnore.token;
    if (!isIgnoredMarker && isMarkerActiveInGeneration(marker, state.generation)) {
      return true;
    }
  }
  return false;
}

/** Returns the number of active cron runs in this process. */
export function getActiveCronJobCount() {
  return getActiveCronJobCountForGeneration(getCronActiveJobState());
}

export async function waitForActiveCronJobs(timeoutMs: number): Promise<{
  drained: boolean;
  active: number;
}> {
  const state = getCronActiveJobState();
  if (getActiveCronJobCountForGeneration(state) === 0) {
    return { drained: true, active: 0 };
  }
  await new Promise<void>((resolve) => {
    const waiter = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(
      () => {
        state.emptyWaiters.delete(waiter);
        resolve();
      },
      Math.max(0, Math.floor(timeoutMs)),
    );
    state.emptyWaiters.add(waiter);
  });
  const active = getActiveCronJobCountForGeneration(state);
  return {
    drained: active === 0,
    active,
  };
}

/** Starts a new process-lifecycle generation without clearing still-finalizing old runs. */
export function advanceCronActiveJobGeneration() {
  const state = getCronActiveJobState();
  state.generation += 1;
  for (const [jobId, marker] of state.activeJobs) {
    if (marker.preserveAcrossGenerationAdvance === true) {
      continue;
    }
    if (marker.generation < state.generation - 1) {
      state.activeJobs.delete(jobId);
    }
  }
  notifyActiveCronJobWaitersIfEmpty(state);
}

/** Clears process-global cron active-job state at process-lifecycle boundaries. */
export function resetCronActiveJobs() {
  const state = getCronActiveJobState();
  state.generation += 1;
  state.activeJobs.clear();
  notifyActiveCronJobWaitersIfEmpty(state);
}
