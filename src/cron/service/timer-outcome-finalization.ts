/** Finalizes cron task rows and active markers after timer outcome persistence. */
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import {
  CronRunReceiptRevisionError,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { locked } from "./locked.js";
import { releaseQueuedCronRun, supersedeActivatedCronRun } from "./run-admission.js";
import { cronRunReceiptPersistHooks, supersedeServiceCronRunReceipt } from "./run-receipts.js";
import { recomputeUnownedCronSchedules } from "./run-recovery.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { emit, type CronServiceState, type DeferredCronNotifications } from "./state.js";
import { ensureLoaded, publishCronRuntimeRows, runPostPersistCronNotifications } from "./store.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { emitCronOutcomeEventForJob, recordCronOutcomeForJob } from "./timer-outcome-events.js";
import { applyOutcomeToAuthoritativeJob, applyOutcomeToStoredJob } from "./timer-outcomes.js";

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
  const canPublish = (outcome: TimedCronRunOutcome) =>
    !(state.stopped && opts?.discardWhenStopped) &&
    isCronActiveJobMarkerCurrent(outcome.activeJobMarker);
  try {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      // Payload outcomes survive a failed row write as recovery facts. Quiet
      // evaluations have no payload outcome and finalize only after the commit.
      for (const outcome of outcomes) {
        if (outcome.status !== "ok" || outcome.triggerEval?.fired !== false) {
          const taskJob = structuredClone(
            state.store?.jobs.find((job) => job.id === outcome.jobId) ?? outcome.job,
          );
          applyOutcomeToAuthoritativeJob(state, taskJob, outcome, {
            deferredNotifications: [],
            emit: false,
          });
          recordCronOutcomeForJob(state, taskJob, outcome);
        }
      }
      // Retirement fences publication, not the exact receipt's durable result.
      // The transaction revalidates ownership before touching authoritative rows.
      finalizedOutcomes = outcomes.filter((outcome) => outcome.runReceipt || canPublish(outcome));
      if (finalizedOutcomes.length === 0) {
        finalizationSucceeded = true;
        return;
      }

      const postPersistNotifications: DeferredCronNotifications = [];
      const receiptHooks = finalizedOutcomes
        .filter((outcome) => outcome.runReceipt)
        .map((outcome) =>
          cronRunReceiptPersistHooks({
            state,
            handle: outcome.runReceipt!,
            allowMissingJob:
              outcome.activeJobMarker?.jobRemoved === true ||
              !state.store?.jobs.some((job) => job.id === outcome.jobId),
            terminal: {
              status: outcome.status,
              ...(outcome.triggerEval ? { triggerFired: outcome.triggerEval.fired } : {}),
              finishedAtMs: outcome.endedAt,
              error: outcome.error,
              ...(outcome.receiptSettlementDisposition
                ? { disposition: outcome.receiptSettlementDisposition }
                : {}),
            },
          }),
        );
      const transactionHooks =
        receiptHooks.length > 0
          ? {
              beforeWrite: (
                database: Parameters<NonNullable<(typeof receiptHooks)[number]["beforeWrite"]>>[0],
              ) => {
                for (const hooks of receiptHooks) {
                  hooks.beforeWrite?.(database);
                }
              },
              afterWrite: (
                database: Parameters<NonNullable<(typeof receiptHooks)[number]["afterWrite"]>>[0],
              ) => {
                for (const hooks of receiptHooks) {
                  hooks.afterWrite?.(database);
                }
              },
              afterCommit: () => {
                for (const hooks of receiptHooks) {
                  hooks.afterCommit?.();
                }
              },
            }
          : undefined;
      const committed = commitCronRuntimeRows({
        state,
        jobIds: finalizedOutcomes.map((outcome) => outcome.jobId),
        operationLabel: "cron.run-finalization",
        transactionHooks,
        mutate: ({ jobs }) => {
          const upsertedJobs: CronJob[] = [];
          const removedJobs: CronJob[] = [];
          const eventPlans: Array<{ outcome: TimedCronRunOutcome; job?: CronJob }> = [];
          for (const outcome of finalizedOutcomes) {
            const job = jobs.get(outcome.jobId);
            if (!job || outcome.activeJobMarker?.jobRemoved === true) {
              eventPlans.push({ outcome });
              continue;
            }
            if (
              applyOutcomeToAuthoritativeJob(state, job, outcome, {
                deferredNotifications: postPersistNotifications,
                emit: false,
              })
            ) {
              removedJobs.push(job);
            } else {
              upsertedJobs.push(job);
            }
            eventPlans.push({ outcome, job: structuredClone(job) });
          }
          return {
            deleteJobIds: removedJobs.map((job) => job.id),
            upsertJobIds: upsertedJobs.map((job) => job.id),
            value: { eventPlans, removedJobs, upsertedJobs },
          };
        },
      });
      applyCronRuntimeRowsToState(
        state,
        committed.upsertedJobs,
        committed.removedJobs.map((job) => job.id),
        { publish: false },
      );
      for (const outcome of finalizedOutcomes) {
        if (outcome.status === "ok" && outcome.triggerEval?.fired === false) {
          tryFinishCronTaskRunWithoutHistory(state, outcome);
        }
        if (!canPublish(outcome)) {
          // Observe retired rows without publishing their schedule changes when
          // this transaction also contains a still-current sibling outcome.
          state.durableNextRunAtMsByJobId.set(
            outcome.jobId,
            state.store?.jobs.find((job) => job.id === outcome.jobId)?.state.nextRunAtMs,
          );
        }
      }
      finalizedOutcomes = finalizedOutcomes.filter(canPublish);
      finalizationSucceeded = true;
      if (finalizedOutcomes.length === 0) {
        runPostPersistCronNotifications(state, postPersistNotifications);
        return;
      }
      const publishedJobIds = new Set(finalizedOutcomes.map((outcome) => outcome.jobId));
      for (const plan of committed.eventPlans) {
        if (!publishedJobIds.has(plan.outcome.jobId)) {
          continue;
        }
        if (plan.job) {
          emitCronOutcomeEventForJob(state, plan.job, plan.outcome);
        } else {
          applyOutcomeToStoredJob(state, plan.outcome, {
            deferredNotifications: postPersistNotifications,
          });
        }
      }
      runPostPersistCronNotifications(state, postPersistNotifications);
      for (const removedJob of committed.removedJobs) {
        if (publishedJobIds.has(removedJob.id)) {
          emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
        }
      }
      publishCronRuntimeRows(state);
      try {
        const maintenance = recomputeUnownedCronSchedules(
          state,
          opts?.repairFutureCronNextRunAtMs === false
            ? { repairFutureCronNextRunAtMs: false }
            : undefined,
        );
        applyCronRuntimeRowsToState(state, maintenance.jobs);
        runPostPersistCronNotifications(state, maintenance.notifications);
      } catch (error) {
        state.deps.log.warn(
          { err: String(error) },
          "cron: post-finalization schedule maintenance failed",
        );
      }
    });

    finalizationSucceeded ||= finalizedOutcomes.length > 0;
    return finalizedOutcomes;
  } catch (error) {
    if (error instanceof CronRunReceiptRevisionError) {
      const stale = outcomes.find((outcome) => outcome.runReceipt?.receiptId === error.receiptId);
      if (stale?.runReceipt) {
        // A retired reservation's millisecond marker cannot identify a successor.
        // Keep its terminal fact and receipt for recovery if the guard rejects it.
        if (isCronActiveJobMarkerCurrent(stale.activeJobMarker)) {
          if (stale.reservationIdentity) {
            await supersedeActivatedCronRun({
              state,
              jobId: stale.jobId,
              reservationIdentity: stale.reservationIdentity,
              runReceipt: stale.runReceipt,
              reason: error.message,
            });
          } else {
            supersedeServiceCronRunReceipt(stale.runReceipt, state.deps.nowMs(), error.message);
          }
          tryFinishCronTaskRunWithoutHistory(state, {
            taskRunId: stale.taskRunId,
            status: "skipped",
            error: error.message,
            endedAt: state.deps.nowMs(),
          });
        }
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
      if (opts?.clearOnFailure !== false || finalizationSucceeded) {
        clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
      }
      if (outcome.runReceipt) {
        releaseLocalCronRunReceiptOwnership(outcome.runReceipt);
      }
    }
  }
}
