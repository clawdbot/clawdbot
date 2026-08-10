import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { markCronJobActive } from "../active-jobs.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { type CronServiceState, type DeferredCronNotifications, emit } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { tryCreateCronTaskRun } from "./task-runs.js";
import {
  runsDetachedFromMainSession,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { isRunnableJob } from "./timer-runnable.js";

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

function restoreQueuedCronRunReservationLastError(
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
  opts?: { restoreLastError?: boolean },
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
  if (opts?.restoreLastError !== false) {
    restoreQueuedCronRunReservationLastError(state, jobId, identity, jobState);
  }
  if (queuedMatches) {
    delete jobState.queuedAtMs;
  }
  if (runningMatches) {
    delete jobState.runningAtMs;
  }
  return true;
}

type QueuedCronRunReservation = {
  jobId: string;
  reservationIdentity: object;
};

export function clearOwnedQueuedCronRunMarkers(
  state: CronServiceState,
  reservations: readonly QueuedCronRunReservation[],
  opts?: { restoreLastError?: boolean },
): QueuedCronRunReservation[] {
  const pendingReleases: QueuedCronRunReservation[] = [];
  for (const reservation of reservations) {
    const job = state.store?.jobs.find((entry) => entry.id === reservation.jobId);
    if (
      job &&
      clearQueuedCronRunReservationMarker(
        state,
        reservation.jobId,
        reservation.reservationIdentity,
        job.state,
        opts,
      )
    ) {
      pendingReleases.push(reservation);
    } else {
      releaseQueuedCronRun(state, reservation.jobId, reservation.reservationIdentity);
    }
  }
  return pendingReleases;
}

/** Durably clears reservations still owned by this process. Ownership stays
 * held through commit; after one retry it is dropped for restart repair. */
export async function cleanupQueuedCronRunReservations(params: {
  state: CronServiceState;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: "maintenance" | "startup-overflow";
}): Promise<void> {
  const { state, reservations } = params;
  const attempt = async () => {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const rollbackSnapshot = snapshotStoreForRollback(state);
      const pendingReleases = clearOwnedQueuedCronRunMarkers(state, reservations, {
        restoreLastError: params.restoreLastError,
      });
      if (pendingReleases.length === 0) {
        return;
      }
      const postPersistNotifications: DeferredCronNotifications = [];
      if (params.recompute) {
        recomputeNextRunsForMaintenance(state, {
          ...(params.recompute === "startup-overflow"
            ? { repairFutureCronNextRunAtMs: false }
            : {}),
          deferredNotifications: postPersistNotifications,
        });
      }
      await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
      for (const reservation of pendingReleases) {
        releaseQueuedCronRun(state, reservation.jobId, reservation.reservationIdentity);
      }
    });
  };
  try {
    await attempt();
  } catch {
    try {
      await attempt();
    } catch (error) {
      for (const reservation of reservations) {
        releaseQueuedCronRun(state, reservation.jobId, reservation.reservationIdentity);
      }
      throw error;
    }
  }
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

/** Apply one service-level cap to every cron execution source. Queue waiters
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

export async function executeQueuedCronRun(params: {
  state: CronServiceState;
  jobId: string;
  reservedAtMs: number;
  reservationIdentity: object;
  runnableOptions?: Omit<Parameters<typeof isRunnableJob>[0], "state" | "job" | "nowMs">;
  isUnavailable?: () => boolean;
  onUnavailable?: () => void;
  onActivated?: () => void;
  onNotRunnable: (job: CronJob) => Promise<void>;
  onSetupError?: (job: CronJob, errorText: string) => void;
  /** Runs before admission release; true means terminal handling is complete. */
  onCompleted?: (outcome: TimedCronRunOutcome) => Promise<boolean>;
}): Promise<
  | { kind: "stopped" }
  | { kind: "skipped" }
  | { kind: "completed"; outcome: TimedCronRunOutcome; handled: boolean }
> {
  const { state } = params;
  let activated = false;
  const admission = await runWithCronAdmission(state, async () => {
    const started = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      if (params.isUnavailable?.() || state.stopped || state.restartRecoveryPending) {
        params.onUnavailable?.();
        return undefined;
      }
      const job = state.store?.jobs.find((entry) => entry.id === params.jobId);
      if (
        !job ||
        !isQueuedCronRunReservationCurrent(state, params.jobId, params.reservationIdentity) ||
        job.state.queuedAtMs !== params.reservedAtMs
      ) {
        releaseQueuedCronRun(state, params.jobId, params.reservationIdentity);
        return undefined;
      }
      const runnableJob = structuredClone(job);
      delete runnableJob.state.queuedAtMs;
      if (
        !isRunnableJob({
          state,
          job: runnableJob,
          nowMs: state.deps.nowMs(),
          ...params.runnableOptions,
        })
      ) {
        await params.onNotRunnable(job);
        return undefined;
      }
      const activation = await activateQueuedCronRun({
        state,
        job,
        reservationIdentity: params.reservationIdentity,
        onUnavailable: params.onUnavailable,
      });
      if (activation.kind !== "activated") {
        return undefined;
      }
      activated = true;
      params.onActivated?.();
      return { job, startedAt: activation.startedAt };
    });
    if (!started) {
      return undefined;
    }
    const executionJob = structuredClone(started.job);
    executionJob.state.runningAtMs = started.startedAt;
    executionJob.state.lastError = undefined;
    const taskRunId = tryCreateCronTaskRun({
      state,
      job: executionJob,
      startedAt: started.startedAt,
    });
    const activeJobMarker = markCronJobActive(executionJob.id, {
      preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(executionJob),
    });
    emit(state, {
      jobId: executionJob.id,
      action: "started",
      job: executionJob,
      runAtMs: started.startedAt,
    });
    const base = {
      jobId: params.jobId,
      job: executionJob,
      taskRunId,
      activeJobMarker,
      reservationIdentity: params.reservationIdentity,
      startedAt: started.startedAt,
    };
    let outcome: TimedCronRunOutcome;
    try {
      const result = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker,
      });
      outcome = { ...base, ...result, endedAt: state.deps.nowMs() };
    } catch (error) {
      const errorText = normalizeCronRunErrorText(error);
      params.onSetupError?.(executionJob, errorText);
      outcome = {
        ...base,
        status: "error",
        error: errorText,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, {
          nowMs: state.deps.nowMs,
        }),
        endedAt: state.deps.nowMs(),
      };
    }
    return { outcome, handled: (await params.onCompleted?.(outcome)) === true };
  }).catch((error: unknown) => {
    if (activated) {
      releaseQueuedCronRun(state, params.jobId, params.reservationIdentity);
    }
    throw error;
  });
  if (admission.kind === "stopped") {
    return { kind: "stopped" };
  }
  if (!admission.value) {
    return { kind: "skipped" };
  }
  return { kind: "completed", ...admission.value };
}
