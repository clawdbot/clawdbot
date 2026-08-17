import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { markCronJobActive } from "../active-jobs.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import {
  adjudicateActiveCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { enrollForeignReceipt } from "./foreign-receipt-monitor.js";
import { recomputeJobNextRunAtMs } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import {
  activateServiceCronRunReceiptInDatabase,
  claimServiceCronRunReceiptInDatabase,
  cronRunReceiptPersistHooks,
  cronRunReceiptSupersedeHooks,
  prepareServiceCronRunReceiptClaim,
} from "./run-receipts.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { type CronServiceState, type DeferredCronNotifications, emit } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
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
  opts: { runReceipt: CronRunReceiptHandle; preserveWhenDisabled?: boolean },
): object {
  const identity = {};
  state.queuedRunReservationsByJobId.set(jobId, {
    identity,
    markerAtMs: reservationAt,
    runReceipt: opts.runReceipt,
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

type QueuedCronRunReservation = {
  jobId: string;
  reservationIdentity: object;
};

/** Durably clears reservations still owned by this process. Ownership stays
 * held through commit; after one retry it is dropped for restart repair. */
export async function cleanupQueuedCronRunReservations(params: {
  state: CronServiceState;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: "maintenance" | "startup-overflow";
  transactionHooks?: CronStoreTransactionHooks;
}): Promise<void> {
  const { state, reservations } = params;
  const attempt = async () => {
    await locked(state, async () => {
      const postPersistNotifications: DeferredCronNotifications = [];
      const committedJobs = commitCronRuntimeRows({
        state,
        jobIds: reservations.map((reservation) => reservation.jobId),
        operationLabel: "cron.run-reservation-cleanup",
        transactionHooks: params.transactionHooks,
        mutate: ({ database, jobs }) => {
          const committed: CronJob[] = [];
          for (const reservation of reservations) {
            const ownership = state.queuedRunReservationsByJobId.get(reservation.jobId);
            if (ownership?.identity !== reservation.reservationIdentity) {
              continue;
            }
            if (!params.transactionHooks) {
              finishCronRunReceiptInDatabase({
                database,
                handle: ownership.runReceipt,
                status: "skipped",
                finishedAtMs: state.deps.nowMs(),
                error: "cron reservation released before completion",
              });
            }
            const job = jobs.get(reservation.jobId);
            if (!job) {
              continue;
            }
            const queuedMatches = ownership.markerAtMs === job.state.queuedAtMs;
            const runningMatches = ownership.markerAtMs === job.state.runningAtMs;
            if (!queuedMatches && !runningMatches) {
              continue;
            }
            if (params.restoreLastError !== false && ownership.activationPreviousLastError) {
              job.state.lastError = ownership.activationPreviousLastError.value;
            }
            if (queuedMatches) {
              delete job.state.queuedAtMs;
            }
            if (runningMatches) {
              delete job.state.runningAtMs;
            }
            if (params.recompute && job.enabled && job.state.nextRunAtMs === undefined) {
              recomputeJobNextRunAtMs({
                state,
                job,
                nowMs: state.deps.nowMs(),
                deferredNotifications: postPersistNotifications,
              });
            }
            committed.push(job);
          }
          return {
            upsertJobIds: committed.map((job) => job.id),
            value: committed,
          };
        },
      });
      runPostPersistCronNotifications(state, postPersistNotifications);
      applyCronRuntimeRowsToState(state, committedJobs);
      for (const reservation of reservations) {
        const ownership = state.queuedRunReservationsByJobId.get(reservation.jobId);
        if (ownership?.identity === reservation.reservationIdentity) {
          releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
        }
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
        const ownership = state.queuedRunReservationsByJobId.get(reservation.jobId);
        if (ownership?.identity === reservation.reservationIdentity) {
          releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
        }
        releaseQueuedCronRun(state, reservation.jobId, reservation.reservationIdentity);
      }
      throw error;
    }
  }
}

/** Supersedes one activated run and releases only its exact durable marker.
 * Receipt terminalization shares the marker transaction, so no successor can
 * enter between dropping the fence and repairing scheduling state. */
export async function supersedeActivatedCronRun(params: {
  state: CronServiceState;
  jobId: string;
  reservationIdentity: object;
  runReceipt: ReturnType<typeof prepareServiceCronRunReceiptClaim>["handle"];
  reason: string;
}): Promise<void> {
  try {
    await cleanupQueuedCronRunReservations({
      state: params.state,
      reservations: [params],
      recompute: "maintenance",
      transactionHooks: cronRunReceiptSupersedeHooks({
        state: params.state,
        handle: params.runReceipt,
        finishedAtMs: params.state.deps.nowMs(),
        error: params.reason,
      }),
    });
  } finally {
    releaseLocalCronRunReceiptOwnership(params.runReceipt);
  }
}

/** Persists queued markers only while no gateway owns an active run receipt.
 * Each retry re-reads and updates only pending rows, so excluded foreign jobs
 * can advance without a stale full-store snapshot overwriting their state.
 */
export async function persistQueuedCronRunReservations(params: {
  state: CronServiceState;
  candidates: readonly CronJob[];
  immediateJobIds?: ReadonlySet<string>;
  reservedAtMs: number;
}): Promise<Array<{ job: CronJob; runReceipt: CronRunReceiptHandle }>> {
  const pendingJobs = new Map(params.candidates.map((job) => [job.id, structuredClone(job)]));
  const preparedClaims = new Map(
    [...pendingJobs].map(([jobId, job]) => [
      jobId,
      prepareServiceCronRunReceiptClaim({
        state: params.state,
        job,
        startedAtMs: params.reservedAtMs,
      }),
    ]),
  );
  while (pendingJobs.size > 0) {
    const replacedReceipts: CronRunReceiptHandle[] = [];
    try {
      const committedReservations = commitCronRuntimeRows({
        state: params.state,
        jobIds: pendingJobs.keys(),
        operationLabel: "cron.run-reservation",
        mutate: ({ database, jobs }) => {
          const jobIds = [...pendingJobs.keys()].toSorted();
          for (const jobId of jobIds) {
            if (!params.state.queuedRunReservationsByJobId.has(jobId)) {
              adjudicateActiveCronRunReceiptInDatabase({
                database,
                jobId,
                prepared: preparedClaims.get(jobId)!,
                finishedAtMs: params.reservedAtMs,
              });
            }
          }
          const committed: CronJob[] = [];
          for (const jobId of jobIds) {
            const job = jobs.get(jobId);
            const planned = pendingJobs.get(jobId);
            if (
              !job ||
              !planned ||
              job.enabled !== planned.enabled ||
              (!params.immediateJobIds?.has(jobId) &&
                job.state.nextRunAtMs !== planned.state.nextRunAtMs) ||
              job.state.lastRunAtMs !== planned.state.lastRunAtMs ||
              job.state.lastRunStatus !== planned.state.lastRunStatus ||
              job.state.queuedAtMs !== undefined ||
              job.state.runningAtMs !== undefined ||
              resolveCronJobConfigRevision(job) !== resolveCronJobConfigRevision(planned)
            ) {
              continue;
            }
            committed.push(job);
          }
          const reservations = committed.map((job) => {
            const prior = params.state.queuedRunReservationsByJobId.get(job.id)?.runReceipt;
            if (prior) {
              finishCronRunReceiptInDatabase({
                database,
                handle: prior,
                status: "superseded",
                finishedAtMs: params.reservedAtMs,
                error: "cron reservation replaced before activation",
              });
              replacedReceipts.push(prior);
            }
            return {
              job,
              runReceipt: claimServiceCronRunReceiptInDatabase(
                params.state,
                database,
                preparedClaims.get(job.id)!,
              ),
            };
          });
          for (const { job } of reservations) {
            job.state.queuedAtMs = params.reservedAtMs;
          }
          return {
            upsertJobIds: committed.map((job) => job.id),
            value: reservations,
          };
        },
      });
      for (const receipt of replacedReceipts) {
        releaseLocalCronRunReceiptOwnership(receipt);
      }
      const committedJobs = committedReservations.map(({ job }) => job);
      if (params.state.stopped) {
        const committedById = new Map(committedJobs.map((job) => [job.id, job] as const));
        if (params.state.store) {
          params.state.store.jobs = params.state.store.jobs.map(
            (job) => committedById.get(job.id) ?? job,
          );
        }
        return committedReservations;
      }
      // A failed refresh cannot orphan committed markers before local ownership.
      await ensureLoaded(params.state, { forceReload: true, skipRecompute: true }).catch(() =>
        applyCronRuntimeRowsToState(params.state, committedJobs),
      );
      const committed = new Set(committedJobs.map((job) => job.id));
      const receiptByJobId = new Map(
        committedReservations.map(({ job, runReceipt }) => [job.id, runReceipt] as const),
      );
      const reloadedReservations = (params.state.store?.jobs ?? [])
        .filter((job) => committed.has(job.id))
        .map((job) => ({ job, runReceipt: receiptByJobId.get(job.id)! }));
      const reloadedJobIds = new Set(reloadedReservations.map(({ job }) => job.id));
      for (const reservation of committedReservations) {
        if (reloadedJobIds.has(reservation.job.id)) {
          continue;
        }
        finishCronRunReceipt({
          handle: reservation.runReceipt,
          status: "skipped",
          finishedAtMs: params.state.deps.nowMs(),
          error: "cron reservation job disappeared before local handoff",
        });
      }
      return reloadedReservations;
    } catch (error) {
      for (const prepared of preparedClaims.values()) {
        releaseLocalCronRunReceiptOwnership(prepared.handle);
      }
      if (!(error instanceof CronRunReceiptConflictError)) {
        throw error;
      }
      enrollForeignReceipt(params.state, error.candidate);
      pendingJobs.delete(error.candidate.jobId);
    }
  }
  await ensureLoaded(params.state, { forceReload: true, skipRecompute: true });
  return [];
}

export async function activateQueuedCronRun(params: {
  state: CronServiceState;
  job: CronJob;
  reservationIdentity: object;
  onUnavailable?: () => void;
  onUnavailableRollbackError?: () => Promise<void>;
}): Promise<
  | {
      kind: "activated";
      job: CronJob;
      startedAt: number;
      runReceipt: ReturnType<typeof prepareServiceCronRunReceiptClaim>["handle"];
    }
  | { kind: "fenced" }
  | { kind: "unavailable"; reason: "stopped" }
> {
  const { state, job, reservationIdentity } = params;
  const startedAt = state.deps.nowMs();
  const reservation = state.queuedRunReservationsByJobId.get(job.id);
  const runReceipt = reservation?.runReceipt;
  if (!reservation || reservation.identity !== reservationIdentity || !runReceipt) {
    return { kind: "fenced" };
  }
  let previousLastError: string | undefined;
  let activatedJob: CronJob | undefined;
  let activatedReceipt: CronRunReceiptHandle | undefined;
  try {
    activatedJob = commitCronRuntimeRows({
      state,
      jobIds: [job.id],
      operationLabel: "cron.run-activation",
      mutate: ({ database, jobs }) => {
        const current = jobs.get(job.id);
        const markerAtMs = state.queuedRunReservationsByJobId.get(job.id)?.markerAtMs;
        if (!current || markerAtMs === undefined || current.state.queuedAtMs !== markerAtMs) {
          return { value: undefined, runHooks: false };
        }
        previousLastError = current.state.lastError;
        activatedReceipt = activateServiceCronRunReceiptInDatabase(
          state,
          database,
          runReceipt,
          startedAt,
        );
        delete current.state.queuedAtMs;
        current.state.runningAtMs = startedAt;
        current.state.lastError = undefined;
        return { value: current, upsertJobIds: [current.id] };
      },
    });
  } catch (error) {
    if (error instanceof CronRunReceiptConflictError) {
      enrollForeignReceipt(state, error.candidate);
      return { kind: "fenced" };
    }
    if (error instanceof CronRunReceiptRevisionError) {
      return { kind: "fenced" };
    }
    throw error;
  }
  if (!activatedJob) {
    return { kind: "fenced" };
  }
  applyCronRuntimeRowsToState(state, [activatedJob]);
  if (reservation?.identity === reservationIdentity) {
    reservation.markerAtMs = startedAt;
    reservation.runReceipt = activatedReceipt!;
    reservation.activationPreviousLastError = { value: previousLastError };
  }
  if (!state.stopped) {
    return { kind: "activated", job: activatedJob, startedAt, runReceipt: activatedReceipt! };
  }

  params.onUnavailable?.();
  try {
    const restoredJob = commitCronRuntimeRows({
      state,
      jobIds: [job.id],
      operationLabel: "cron.run-activation-unavailable",
      transactionHooks: cronRunReceiptPersistHooks({
        state,
        handle: activatedReceipt!,
        terminal: {
          status: "skipped",
          finishedAtMs: state.deps.nowMs(),
          error: "cron service stopped",
        },
      }),
      mutate: ({ jobs }) => {
        const current = jobs.get(job.id);
        if (!current || current.state.runningAtMs !== startedAt) {
          return { value: undefined };
        }
        current.state.lastError = previousLastError;
        delete current.state.runningAtMs;
        return { value: current, upsertJobIds: [current.id] };
      },
    });
    if (restoredJob) {
      applyCronRuntimeRowsToState(state, [restoredJob]);
    }
  } catch (error) {
    await params.onUnavailableRollbackError?.();
    throw error;
  } finally {
    releaseLocalCronRunReceiptOwnership(activatedReceipt!);
  }
  releaseQueuedCronRun(state, job.id, reservationIdentity);
  return {
    kind: "unavailable",
    reason: "stopped",
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
      if (params.isUnavailable?.() || state.stopped) {
        params.onUnavailable?.();
        return undefined;
      }
      const job = state.store?.jobs.find((entry) => entry.id === params.jobId);
      if (
        !job ||
        !isQueuedCronRunReservationCurrent(state, params.jobId, params.reservationIdentity) ||
        job.state.queuedAtMs !== params.reservedAtMs
      ) {
        const ownership = state.queuedRunReservationsByJobId.get(params.jobId);
        if (ownership?.identity === params.reservationIdentity) {
          // A concurrent disable/remove wiped the queued marker while this
          // reservation waited on admission. Its receipt is still running and
          // locally owned; abandoning it here would self-fence the job forever
          // (every later reservation hits the receipt-conflict monitor), so
          // terminalize like cleanupQueuedCronRunReservations does. locked()
          // is non-reentrant, hence the direct finish instead of that helper.
          try {
            finishCronRunReceipt({
              handle: ownership.runReceipt,
              status: "skipped",
              finishedAtMs: state.deps.nowMs(),
              error: "cron reservation fenced by concurrent mutation",
            });
          } catch {
            // finishCronRunReceipt retained ownership and scheduled a retry.
          }
        }
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
      return {
        job: activation.job,
        startedAt: activation.startedAt,
        runReceipt: activation.runReceipt,
      };
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
      publicRunId: started.runReceipt.receiptId,
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
      runReceipt: started.runReceipt,
    };
    let outcome: TimedCronRunOutcome;
    try {
      const result = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker,
        runReceipt: started.runReceipt,
      });
      outcome = { ...base, ...result, endedAt: state.deps.nowMs() };
    } catch (error) {
      const receiptSettlementDisposition =
        error instanceof CronRunReceiptRevisionError && error.reason === "owner-unavailable"
          ? "owner-unavailable"
          : undefined;
      const errorText =
        error instanceof CronRunReceiptRevisionError
          ? error.message
          : normalizeCronRunErrorText(error);
      params.onSetupError?.(executionJob, errorText);
      outcome = {
        ...base,
        status: "error",
        error: errorText,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, {
          nowMs: state.deps.nowMs,
        }),
        ...(receiptSettlementDisposition ? { receiptSettlementDisposition } : {}),
        endedAt: state.deps.nowMs(),
      };
    }
    return { outcome, handled: (await params.onCompleted?.(outcome)) === true };
  }).catch(async (error: unknown) => {
    if (activated) {
      await cleanupQueuedCronRunReservations({
        state,
        reservations: [{ jobId: params.jobId, reservationIdentity: params.reservationIdentity }],
        recompute: "maintenance",
      });
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
