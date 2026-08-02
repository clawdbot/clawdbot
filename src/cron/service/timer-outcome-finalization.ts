/** Finalizes cron task rows and active markers after timer outcome persistence. */
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
import { locked } from "./locked.js";
import { clearQueuedCronRunReservationMarker, releaseQueuedCronRun } from "./run-admission.js";
import { emit, type CronServiceState, type DeferredCronNotifications } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { applyOutcomeToStoredJob } from "./timer-outcomes.js";

type CronTaskRunFinalizationOutcome = {
  jobId: string;
  taskRunId?: string;
  status: "ok" | "error" | "skipped";
  error?: unknown;
  endedAt: number;
  summary?: string;
  childSessionKey?: string;
  triggerEval?: { fired: boolean };
  activeJobMarker?: CronActiveJobMarker;
};

type StartupCatchupReservationPlan = {
  candidates: readonly { jobId: string; reservedAtMs: number; reservationIdentity: object }[];
};

type CompletedCronRunOutcomeFinalizationOptions = {
  clearOnFailure?: boolean;
  discardWhenStopped?: boolean;
  repairFutureCronNextRunAtMs?: boolean;
};

/** Coalesces terminal cron writes without holding an execution admission slot. */
export function createCompletedCronRunOutcomeDrain(
  state: CronServiceState,
  opts?: CompletedCronRunOutcomeFinalizationOptions,
) {
  const pendingOutcomes: TimedCronRunOutcome[] = [];
  const finalizedOutcomes: TimedCronRunOutcome[] = [];
  let drainPromise: Promise<void> | undefined;
  let drainFailure: { error: unknown } | undefined;

  const startDrain = () => {
    if (drainPromise || pendingOutcomes.length === 0) {
      return;
    }
    // Sibling workers can finish together; yield before snapshotting so one
    // locked reload and write settles every outcome already in the queue.
    drainPromise = Promise.resolve()
      .then(async () => {
        while (pendingOutcomes.length > 0) {
          const completed = pendingOutcomes.splice(0);
          try {
            finalizedOutcomes.push(
              ...(await finalizeCompletedCronRunOutcomes(state, completed, opts)),
            );
          } catch (error) {
            // One failed store write cannot abandon sibling outcomes: their
            // marker and reservation cleanup still belongs to this drain.
            drainFailure ??= { error };
          }
        }
      })
      .catch((error: unknown) => {
        // Keep background failures observed; the owning scheduler propagates
        // them when it joins the drain before completing its batch.
        drainFailure ??= { error };
      })
      .finally(() => {
        drainPromise = undefined;
        if (pendingOutcomes.length > 0) {
          startDrain();
        }
      });
  };

  return {
    enqueue(outcome: TimedCronRunOutcome) {
      pendingOutcomes.push(outcome);
      startDrain();
    },
    async flush(): Promise<TimedCronRunOutcome[]> {
      for (;;) {
        const pendingDrain = drainPromise;
        if (!pendingDrain) {
          break;
        }
        await pendingDrain;
      }
      if (drainFailure) {
        throw drainFailure.error;
      }
      return finalizedOutcomes.splice(0);
    },
  };
}

/** Durably finalizes finished work without waiting for unrelated cron runs. */
export async function finalizeCompletedCronRunOutcomes(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
  opts?: CompletedCronRunOutcomeFinalizationOptions,
): Promise<TimedCronRunOutcome[]> {
  if (outcomes.length === 0) {
    return [];
  }

  let finalizedOutcomes: TimedCronRunOutcome[] = [];
  let finalizationSucceeded = false;
  try {
    const currentOutcomes = filterCurrentCronRunOutcomes(outcomes);
    if (currentOutcomes.length === 0) {
      finishRetiredCronTaskRuns(state, outcomes, currentOutcomes);
      return [];
    }

    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      if (state.stopped && opts?.discardWhenStopped) {
        // A replacement service owns the durable markers after shutdown;
        // only retire the old run's task row without rewriting its state.
        finishRetiredCronTaskRuns(state, outcomes, []);
        finalizationSucceeded = true;
        return;
      }
      finalizedOutcomes = filterCurrentCronRunOutcomes(currentOutcomes);
      finishRetiredCronTaskRuns(state, outcomes, finalizedOutcomes);
      if (finalizedOutcomes.length === 0) {
        return;
      }

      const rollbackSnapshot = snapshotStoreForRollback(state);
      const removedJobs: CronJob[] = [];
      const postPersistNotifications: DeferredCronNotifications = [];
      for (const outcome of finalizedOutcomes) {
        const removedJob = applyOutcomeToStoredJob(state, outcome, {
          deferredNotifications: postPersistNotifications,
        });
        if (removedJob) {
          removedJobs.push(removedJob);
        }
      }

      // Preserve sibling jobs that became due while this run was executing.
      // Startup overflow additionally owns its explicit deferred wake times.
      recomputeNextRunsForMaintenance(
        state,
        opts?.repairFutureCronNextRunAtMs === false
          ? {
              repairFutureCronNextRunAtMs: false,
              deferredNotifications: postPersistNotifications,
            }
          : { deferredNotifications: postPersistNotifications },
      );
      // Run notifications describe durable state. Drain them only after the
      // terminal write succeeds so rollback cannot publish a false outcome.
      await persistOrRestore(state, rollbackSnapshot, {
        postPersistNotifications,
      });
      finishPersistedQuietCronTaskRuns(state, finalizedOutcomes);
      for (const removedJob of removedJobs) {
        emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
      }
    });

    finalizationSucceeded ||= finalizedOutcomes.length > 0;
    return finalizedOutcomes;
  } finally {
    for (const outcome of outcomes) {
      if (outcome.reservationIdentity) {
        releaseQueuedCronRun(state, outcome.jobId, outcome.reservationIdentity);
      }
    }
    if (opts?.clearOnFailure !== false || finalizationSucceeded) {
      clearActiveMarkersForOutcomes(outcomes);
    }
  }
}

function finishPersistedQuietCronTaskRuns(
  state: CronServiceState,
  outcomes: readonly CronTaskRunFinalizationOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.status === "ok" && outcome.triggerEval && !outcome.triggerEval.fired) {
      tryFinishCronTaskRunWithoutHistory(state, outcome);
    }
  }
}

function clearActiveMarkersForOutcomes(outcomes: readonly CronTaskRunFinalizationOutcome[]): void {
  for (const outcome of outcomes) {
    clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
  }
}

function filterCurrentCronRunOutcomes<T extends CronTaskRunFinalizationOutcome>(
  outcomes: readonly T[],
): T[] {
  return outcomes.filter((outcome) => isCronActiveJobMarkerCurrent(outcome.activeJobMarker));
}

function finishRetiredCronTaskRuns<T extends CronTaskRunFinalizationOutcome>(
  state: CronServiceState,
  outcomes: readonly T[],
  currentOutcomes: readonly T[],
): void {
  const current = new Set(currentOutcomes);
  for (const outcome of outcomes) {
    if (!current.has(outcome)) {
      tryFinishCronTaskRunWithoutHistory(state, outcome);
    }
  }
}

export function clearUnstartedStartupCatchupReservationMarkers(
  state: CronServiceState,
  plan: StartupCatchupReservationPlan,
  outcomes: readonly CronTaskRunFinalizationOutcome[],
): Array<{ jobId: string; reservationIdentity: object }> {
  const pendingReleases: Array<{ jobId: string; reservationIdentity: object }> = [];
  const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
  for (const candidate of plan.candidates) {
    if (startedJobIds.has(candidate.jobId)) {
      continue;
    }
    const job = state.store?.jobs.find((entry) => entry.id === candidate.jobId);
    if (
      job &&
      clearQueuedCronRunReservationMarker(
        state,
        candidate.jobId,
        candidate.reservationIdentity,
        job.state,
      )
    ) {
      pendingReleases.push(candidate);
    } else {
      releaseQueuedCronRun(state, candidate.jobId, candidate.reservationIdentity);
    }
  }
  return pendingReleases;
}
