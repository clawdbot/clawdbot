// Shared execution admission for scheduled, manual, and on-exit cron runs.
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { persistOrRestore, snapshotStoreForRollback } from "./store.js";

export function resolveRunConcurrency(): number {
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

function acquireCronRunSlot(state: CronServiceState): () => void {
  state.runAdmission.active += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.runAdmission.active -= 1;
    dispatchWaiters(state);
  };
}

function dispatchWaiters(state: CronServiceState): void {
  const admission = state.runAdmission;
  if (state.stopped) {
    cancelCronRunAdmissionWaiters(state);
    return;
  }
  const maxConcurrentRuns = resolveRunConcurrency();
  while (admission.active < maxConcurrentRuns) {
    const waiter = admission.waiters.shift();
    if (!waiter) {
      return;
    }
    waiter(acquireCronRunSlot(state));
  }
}

async function acquireCronRunAdmission(state: CronServiceState): Promise<(() => void) | null> {
  const admission = state.runAdmission;
  if (state.stopped) {
    return null;
  }
  if (admission.waiters.length === 0 && admission.active < resolveRunConcurrency()) {
    return acquireCronRunSlot(state);
  }
  return await new Promise<(() => void) | null>((resolve) => {
    admission.waiters.push(resolve);
  });
}

/** Wake queued work on stop so each caller can release its durable reservation. */
export function cancelCronRunAdmissionWaiters(state: CronServiceState): void {
  const waiters = state.runAdmission.waiters.splice(0);
  for (const waiter of waiters) {
    waiter(null);
  }
}

/** Track a persisted marker through shared admission and payload execution. */
export function reserveQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  reservationAt: number,
  opts?: { preserveWhenDisabled?: boolean },
): object {
  const identity = {};
  state.queuedRunReservationsByJobId.set(jobId, {
    identity,
    markerAtMs: reservationAt,
    preserveWhenDisabled: opts?.preserveWhenDisabled === true,
  });
  return identity;
}

export function releaseQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  identity: object,
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  if (reservation?.identity !== identity) {
    return false;
  }
  state.queuedRunReservationsByJobId.delete(jobId);
  return true;
}

export function isQueuedCronRunReservationCurrent(
  state: CronServiceState,
  jobId: string,
  identity: object,
): boolean {
  return state.queuedRunReservationsByJobId.get(jobId)?.identity === identity;
}

export function restoreQueuedCronRunReservationLastError(
  state: CronServiceState,
  jobId: string,
  identity: object,
  jobState: { lastError?: string },
): void {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  if (reservation?.identity === identity && reservation.activationPreviousLastError) {
    jobState.lastError = reservation.activationPreviousLastError.value;
  }
}

/** Clear a locally owned reservation, including a persisted-but-unstarted activation. */
export function clearQueuedCronRunReservationMarker(
  state: CronServiceState,
  jobId: string,
  identity: object,
  jobState: { queuedAtMs?: number; runningAtMs?: number; lastError?: string },
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  if (reservation?.identity !== identity) {
    return false;
  }
  const queuedMatches = reservation.markerAtMs === jobState.queuedAtMs;
  const runningMatches = reservation.markerAtMs === jobState.runningAtMs;
  if (!queuedMatches && !runningMatches) {
    return false;
  }
  restoreQueuedCronRunReservationLastError(state, jobId, identity, jobState);
  if (queuedMatches) {
    delete jobState.queuedAtMs;
  }
  if (runningMatches) {
    delete jobState.runningAtMs;
  }
  return true;
}

export function isQueuedCronRunReservationMarkerCurrent(
  state: CronServiceState,
  jobId: string,
  identity: object,
  runningAtMs: number,
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  return reservation?.identity === identity && reservation.markerAtMs === runningAtMs;
}

export async function activateQueuedCronRun(params: {
  state: CronServiceState;
  job: CronJob;
  reservationIdentity: object;
  onUnavailable?: () => void;
  onUnavailableRollbackError?: () => Promise<void>;
}): Promise<
  | { kind: "activated"; startedAt: number }
  | { kind: "unavailable"; reason: "stopped" | "restart-recovery-pending" }
> {
  const { state, job, reservationIdentity } = params;
  const startedAt = state.deps.nowMs();
  const previousLastError = job.state.lastError;
  const activationRollbackSnapshot = snapshotStoreForRollback(state);
  delete job.state.queuedAtMs;
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  // Persist running ownership before execution. A failed write restores the
  // durable queued marker so the caller can release or recover that claim.
  await persistOrRestore(state, activationRollbackSnapshot);
  const reservation = state.queuedRunReservationsByJobId.get(job.id);
  if (reservation?.identity === reservationIdentity) {
    reservation.markerAtMs = startedAt;
    reservation.activationPreviousLastError = { value: previousLastError };
  }
  if (!state.stopped && !state.restartRecoveryPending) {
    return { kind: "activated", startedAt };
  }

  params.onUnavailable?.();
  job.state.lastError = previousLastError;
  const rollbackSnapshot = snapshotStoreForRollback(state);
  delete job.state.runningAtMs;
  try {
    await persistOrRestore(state, rollbackSnapshot);
  } catch (error) {
    await params.onUnavailableRollbackError?.();
    throw error;
  }
  releaseQueuedCronRun(state, job.id, reservationIdentity);
  return {
    kind: "unavailable",
    reason: state.stopped ? "stopped" : "restart-recovery-pending",
  };
}

/**
 * Apply one service-level cap to every cron execution source. Queue waiters
 * keep their job reservation, then recheck scheduler state before execution.
 */
export async function runWithCronAdmission<T>(
  state: CronServiceState,
  execute: () => Promise<T>,
): Promise<{ kind: "admitted"; value: T } | { kind: "stopped" }> {
  const release = await acquireCronRunAdmission(state);
  if (!release) {
    return { kind: "stopped" };
  }
  try {
    return { kind: "admitted", value: await execute() };
  } finally {
    release();
  }
}
