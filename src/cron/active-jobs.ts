/** Tracks in-process cron executions so schedulers and wake paths avoid duplicate runs. */
import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
  type OperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import type { CommandLaneTaskMarker } from "../process/command-queue.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CronPayload } from "./types.js";

type CronActiveJobState = {
  activeJobs: Map<string, CronActiveJobMarker>;
  selfRemovalOwners: WeakMap<() => void, () => CronActiveJobMarker | undefined>;
  admittedJobRuns: WeakMap<
    CronActiveJobMarker,
    { context: AdmittedRunContext; assertActive: () => void }
  >;
  generation: number;
  nextToken: number;
  emptyWaiters: Set<() => void>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

export function bindCronJobAdmittedRun(
  marker: CronActiveJobMarker | undefined,
  context: AdmittedRunContext,
  signal: AbortSignal,
): void {
  const assertActive = resolveAdmittedRunActiveAssertion(context, signal);
  if (marker && assertActive && isCronActiveJobMarkerCurrent(marker)) {
    getCronActiveJobState().admittedJobRuns.set(marker, { context, assertActive });
  }
}

/** Captures host-owned admission; neither a copied token nor a same-id run can redeem it. */
export function bindCronSelfRemovalCommitGuard(
  jobId: string,
  instance: OperationalRunInstanceRef,
  commitGuard: () => void,
  assertCallerActive: () => void,
): void {
  const { admittedJobRuns, selfRemovalOwners } = getCronActiveJobState();
  const marker = getCurrentCronActiveJobMarker(jobId);
  const owner = marker && admittedJobRuns.get(marker);
  if (
    !marker ||
    !owner ||
    owner.context.operationalRunInstance.instanceId !== instance.instanceId ||
    owner.context.operationalRunInstance.runId !== instance.runId
  ) {
    return;
  }
  selfRemovalOwners.set(commitGuard, () => {
    try {
      assertCallerActive();
      owner.assertActive();
      return getCurrentCronActiveJobMarker(jobId) === marker &&
        admittedJobRuns.get(marker) === owner
        ? marker
        : undefined;
    } catch {
      return undefined;
    }
  });
}

export type CronActiveJobMarker = {
  jobId: string;
  payloadKind?: CronPayload["kind"];
  generation: number;
  token: number;
  cancellation?:
    | { kind: "bound"; cancel: (reason: string) => void }
    | { kind: "requested"; reason: string };
  scheduleMutated?: true;
  triggerMutated?: true;
  jobRemoved?: true;
  preserveAcrossGenerationAdvance?: boolean;
  onInactive?: Set<() => void>;
  inactiveNotified?: true;
  heartbeatWait?: {
    owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  };
};

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // markers and their admission bindings together so removal still recognizes
  // the exact live owner when execution and Gateway use different module copies.
  const state = resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobs: new Map<string, CronActiveJobMarker>(),
    selfRemovalOwners: new WeakMap(),
    admittedJobRuns: new WeakMap(),
    generation: 0,
    nextToken: 1,
    emptyWaiters: new Set<() => void>(),
  }));
  state.generation ??= 0;
  state.nextToken ??= 1;
  state.activeJobs ??= new Map<string, CronActiveJobMarker>();
  state.selfRemovalOwners ??= new WeakMap();
  state.admittedJobRuns ??= new WeakMap();
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

function getCurrentCronActiveJobMarker(jobId: string): CronActiveJobMarker | undefined {
  if (!jobId) {
    return undefined;
  }
  const state = getCronActiveJobState();
  const marker = state.activeJobs.get(jobId);
  return marker && isMarkerActiveInGeneration(marker, state.generation) ? marker : undefined;
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

function notifyCronJobInactive(marker: CronActiveJobMarker) {
  if (marker.inactiveNotified) {
    return;
  }
  marker.inactiveNotified = true;
  for (const callback of marker.onInactive ?? []) {
    callback();
  }
  marker.onInactive?.clear();
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(
  jobId: string,
  opts?: { payloadKind?: CronPayload["kind"]; preserveAcrossGenerationAdvance?: boolean },
): CronActiveJobMarker | undefined {
  if (!jobId) {
    return undefined;
  }
  const state = getCronActiveJobState();
  const token = state.nextToken;
  state.nextToken += 1;
  const marker: CronActiveJobMarker = {
    jobId,
    ...(opts?.payloadKind ? { payloadKind: opts.payloadKind } : {}),
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
    notifyCronJobInactive(activeMarker);
  } else if (marker?.jobId === jobId) {
    // The caller is finalizing this exact run even when a same-id replacement
    // now owns the map slot. Notify only the retired marker's listeners.
    notifyCronJobInactive(marker);
  }
  notifyActiveCronJobWaitersIfEmpty(state);
}

/** Records a durable schedule edit against the exact run that was active for it. */
export function noteActiveCronJobScheduleMutation(jobId: string): void {
  const marker = getCurrentCronActiveJobMarker(jobId);
  if (marker) {
    // Keep mutation history on the admitted run: A→B→A has the original
    // schedule value but still belongs to the operator's newer edit.
    marker.scheduleMutated = true;
  }
}

/** Records a durable trigger edit against the exact run that evaluated it. */
export function noteActiveCronJobTriggerMutation(jobId: string): void {
  const marker = getCurrentCronActiveJobMarker(jobId);
  if (marker) {
    // A→B→A restores the script but cannot return ownership of the new
    // trigger state to an evaluation admitted before either durable edit.
    marker.triggerMutated = true;
  }
}

/** Retires the admitted job identity after its deletion becomes durable. */
export function noteActiveCronJobRemoval(
  jobId: string,
  commitGuard?: () => void,
): CronActiveJobMarker | undefined {
  const marker = getCurrentCronActiveJobMarker(jobId);
  if (!marker) {
    return undefined;
  }
  // A reused ID names a new job, not a reschedule of the old invocation.
  // Keep its marker until completion so duplicate-run guards remain intact.
  marker.scheduleMutated = true;
  marker.jobRemoved = true;
  // Check the exact live admission again after persistence, while retaining its
  // marker for duplicate exclusion and deferred session cleanup until completion.
  if (!commitGuard || getCronActiveJobState().selfRemovalOwners.get(commitGuard)?.() !== marker) {
    requestCronActiveJobMarkerCancellation(marker, "Cron job removed by operator.");
  }
  return marker;
}

function requestCronActiveJobMarkerCancellation(marker: CronActiveJobMarker, reason: string): void {
  const cancellation = marker.cancellation;
  if (cancellation?.kind === "requested") {
    return;
  }
  marker.cancellation = { kind: "requested", reason };
  cancellation?.cancel(reason);
}

/** Requests cancellation now or when the exact active run binds its controller. */
export function requestActiveCronJobCancellation(jobId: string, reason: string): void {
  const marker = getCurrentCronActiveJobMarker(jobId);
  if (marker) {
    requestCronActiveJobMarkerCancellation(marker, reason);
  }
}

/** Revokes every active run admitted from one payload family. */
export function requestActiveCronJobCancellationByPayloadKind(
  payloadKind: CronPayload["kind"],
  reason: string,
): void {
  const state = getCronActiveJobState();
  for (const marker of state.activeJobs.values()) {
    if (
      marker.payloadKind !== payloadKind ||
      !isMarkerActiveInGeneration(marker, state.generation)
    ) {
      continue;
    }
    requestCronActiveJobMarkerCancellation(marker, reason);
  }
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  return getCurrentCronActiveJobMarker(jobId) !== undefined;
}

/** Runs a callback when the exact cron job no longer has an active in-process run. */
export function onCronJobInactive(
  marker: CronActiveJobMarker | undefined,
  callback: () => void,
): void {
  if (!marker || marker.inactiveNotified) {
    callback();
    return;
  }
  marker.onInactive ??= new Set<() => void>();
  marker.onInactive.add(callback);
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

/** Ignores only the exact cron executions represented by one coalesced heartbeat wake. */
export function hasActiveCronJobsExceptMarkers(markersToIgnore: readonly CronActiveJobMarker[]) {
  const state = getCronActiveJobState();
  const ignoredMarkers = new Set(markersToIgnore);
  for (const marker of state.activeJobs.values()) {
    if (!ignoredMarkers.has(marker) && isMarkerActiveInGeneration(marker, state.generation)) {
      return true;
    }
  }
  return false;
}

/** Records that an exact cron execution is idle until its heartbeat wake settles. */
export function markCronJobWaitingForHeartbeat(
  marker: CronActiveJobMarker | undefined,
  owningCronLaneTaskMarker?: CommandLaneTaskMarker,
): () => void {
  if (!marker || !isCronActiveJobMarkerCurrent(marker)) {
    return () => {};
  }
  const heartbeatWait = owningCronLaneTaskMarker ? { owningCronLaneTaskMarker } : {};
  marker.heartbeatWait = heartbeatWait;
  return () => {
    if (marker.heartbeatWait === heartbeatWait) {
      delete marker.heartbeatWait;
    }
  };
}

/** Returns exact live cron and lane owners currently waiting on heartbeat settlement. */
export function listCronHeartbeatWaitOwners(): {
  activeJobMarkers: CronActiveJobMarker[];
  owningCronLaneTaskMarkers: CommandLaneTaskMarker[];
} {
  const state = getCronActiveJobState();
  const activeJobMarkers: CronActiveJobMarker[] = [];
  const owningCronLaneTaskMarkers: CommandLaneTaskMarker[] = [];
  for (const marker of state.activeJobs.values()) {
    if (!marker.heartbeatWait || !isMarkerActiveInGeneration(marker, state.generation)) {
      continue;
    }
    activeJobMarkers.push(marker);
    if (marker.heartbeatWait.owningCronLaneTaskMarker) {
      owningCronLaneTaskMarkers.push(marker.heartbeatWait.owningCronLaneTaskMarker);
    }
  }
  return { activeJobMarkers, owningCronLaneTaskMarkers };
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
      notifyCronJobInactive(marker);
    }
  }
  notifyActiveCronJobWaitersIfEmpty(state);
}

/** Clears process-global cron active-job state at process-lifecycle boundaries. */
export function resetCronActiveJobs() {
  const state = getCronActiveJobState();
  state.generation += 1;
  for (const marker of state.activeJobs.values()) {
    notifyCronJobInactive(marker);
  }
  state.activeJobs.clear();
  notifyActiveCronJobWaitersIfEmpty(state);
}
