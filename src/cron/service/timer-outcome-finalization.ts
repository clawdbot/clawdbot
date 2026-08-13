/** Finalizes cron task rows and active markers after timer outcome persistence. */
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import {
  CronRunReceiptRevisionError,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { releaseQueuedCronRun } from "./run-admission.js";
import { cronRunReceiptPersistHooks, supersedeServiceCronRunReceipt } from "./run-receipts.js";
import { emit, type CronServiceState, type DeferredCronNotifications } from "./state.js";
import {
  ensureLoaded,
  persistOrRestore,
  pruneCronJobScratchAfterCommit,
  snapshotStoreForRollback,
} from "./store.js";
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
  runReceipt?: CronRunReceiptHandle;
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
      const receiptHooks = finalizedOutcomes
        .filter((outcome) => outcome.runReceipt)
        .map((outcome) =>
          cronRunReceiptPersistHooks({
            state,
            handle: outcome.runReceipt!,
            terminal: {
              status: outcome.status,
              finishedAtMs: outcome.endedAt,
              error: outcome.error,
            },
          }),
        );
      await persistOrRestore(state, rollbackSnapshot, {
        postPersistNotifications,
        ...(receiptHooks.length > 0
          ? {
              transactionHooks: {
                beforeWrite: (database) => {
                  for (const hooks of receiptHooks) {
                    hooks.beforeWrite?.(database);
                  }
                },
                afterWrite: (database) => {
                  for (const hooks of receiptHooks) {
                    hooks.afterWrite?.(database);
                  }
                },
              },
            }
          : {}),
      });
      pruneCronJobScratchAfterCommit(
        state,
        removedJobs.map((job) => job.id),
      );
      finishPersistedQuietCronTaskRuns(state, finalizedOutcomes);
      for (const removedJob of removedJobs) {
        emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
      }
    });

    finalizationSucceeded ||= finalizedOutcomes.length > 0;
    return finalizedOutcomes;
  } catch (error) {
    if (error instanceof CronRunReceiptRevisionError) {
      const stale = outcomes.find((outcome) => outcome.runReceipt?.receiptId === error.receiptId);
      if (stale?.runReceipt) {
        supersedeServiceCronRunReceipt(stale.runReceipt, state.deps.nowMs(), error.message);
        tryFinishCronTaskRunWithoutHistory(state, {
          taskRunId: stale.taskRunId,
          status: "skipped",
          error: error.message,
          endedAt: state.deps.nowMs(),
        });
        const remaining = outcomes.filter((outcome) => outcome !== stale);
        return await finalizeCompletedCronRunOutcomes(state, remaining, opts);
      }
    }
    throw error;
  } finally {
    for (const outcome of outcomes) {
      if (outcome.reservationIdentity) {
        releaseQueuedCronRun(state, outcome.jobId, outcome.reservationIdentity);
      }
    }
    if (opts?.clearOnFailure !== false || finalizationSucceeded) {
      clearActiveMarkersForOutcomes(outcomes);
    }
    for (const outcome of outcomes) {
      if (outcome.runReceipt) {
        releaseLocalCronRunReceiptOwnership(outcome.runReceipt);
      }
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
      if (outcome.runReceipt) {
        supersedeServiceCronRunReceipt(
          outcome.runReceipt,
          state.deps.nowMs(),
          "cron run retired before its result became durable",
        );
      }
      tryFinishCronTaskRunWithoutHistory(state, outcome);
    }
  }
}
