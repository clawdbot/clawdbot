import type { DatabaseSync } from "node:sqlite";
import { materializeLegacyDefaultCronJobOwners } from "../legacy-default-agent-owner-migration.js";
import {
  correctInterruptedCronRunReceiptInDatabase,
  reconcileCronRunReceiptForStartup,
} from "../store/run-receipt-store.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { nextWakeAtMs, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { cancelCronRunAdmissionWaiters } from "./run-admission.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
  STARTUP_INTERRUPTED_ERROR,
} from "./startup-run-repair.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import {
  ensureLoaded,
  persist,
  persistOrRestore,
  pruneCronJobScratchAfterCommit,
  snapshotStoreForRollback,
} from "./store.js";
import { tryFindCronTaskRunIdForRecovery, tryFindFinalizedCronTaskRun } from "./task-runs.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

// Lifecycle-owned freshness exception: only startup-observed foreign active
// receipts are checked, at most once per bounded cadence, until they retire.
const CRON_FOREIGN_RECEIPT_RECHECK_MS = 2_000;
type ForeignReceiptMonitor = {
  startedAtByJobId: Map<string, number>;
  timer: NodeJS.Timeout | null;
};
const foreignReceiptMonitors = new WeakMap<CronServiceState, ForeignReceiptMonitor>();
type FinalizedCronTaskRun = ReturnType<typeof tryFindFinalizedCronTaskRun>;
type RecoveredReceiptCorrection = {
  jobId: string;
  startedAtMs: number;
  status: "ok" | "error" | "skipped";
  finishedAtMs: number;
  error?: string;
};

function foreignReceiptMonitor(state: CronServiceState): ForeignReceiptMonitor {
  let monitor = foreignReceiptMonitors.get(state);
  if (!monitor) {
    monitor = { startedAtByJobId: new Map(), timer: null };
    foreignReceiptMonitors.set(state, monitor);
  }
  return monitor;
}

function repairStoppedCronRun(params: {
  state: CronServiceState;
  job: CronJob;
  runningAtMs: number;
  finalized: FinalizedCronTaskRun;
  deferredNotifications: DeferredCronNotifications;
}): {
  interrupted?: InterruptedStartupRun;
  receiptCorrection?: RecoveredReceiptCorrection;
  replacementAtMs?: number;
  shouldDelete: boolean;
} {
  const { state, job, runningAtMs, deferredNotifications } = params;
  const taskRunId = tryFindCronTaskRunIdForRecovery(state, job.id, runningAtMs);
  const { finalized } = params;
  if (finalized) {
    const repaired = restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs,
      entry: finalized.entry,
      ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
      ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
      deferredNotifications,
    });
    if (repaired) {
      return {
        ...repaired,
        receiptCorrection: {
          jobId: job.id,
          startedAtMs: runningAtMs,
          ...receiptTerminalFromFinalized(finalized),
        },
      };
    }
    state.deps.log.warn(
      { jobId: job.id },
      "cron: treating invalid finalized startup run as interrupted",
    );
  }
  const interrupted = markInterruptedStartupRun({
    state,
    job,
    taskRunId,
    runningAtMs,
    nowMs: state.deps.nowMs(),
    deferredNotifications,
  });
  return {
    interrupted,
    replacementAtMs: interrupted.replacementAtMs,
    shouldDelete: false,
  };
}

function receiptTerminalFromFinalized(finalized: NonNullable<FinalizedCronTaskRun>): {
  status: "ok" | "error" | "skipped";
  finishedAtMs: number;
  error?: string;
} {
  const receiptStatus = (runStatus: CronRunStatus) => {
    if (runStatus === "ok" || runStatus === "skipped") {
      return runStatus;
    }
    return "error";
  };
  return {
    status: receiptStatus(finalized.entry.status),
    finishedAtMs: finalized.entry.ts,
    error: finalized.entry.error,
  };
}

function recoveredReceiptHooks(
  state: CronServiceState,
  corrections: readonly RecoveredReceiptCorrection[],
) {
  if (corrections.length === 0) {
    return undefined;
  }
  return {
    afterWrite: (database: DatabaseSync) => {
      for (const correction of corrections) {
        correctInterruptedCronRunReceiptInDatabase({
          database,
          storePath: state.deps.storePath,
          ...correction,
        });
      }
    },
  };
}

function emitInterruptedRun(state: CronServiceState, interrupted: InterruptedStartupRun): void {
  const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
  emitCronRunFinished(
    state,
    {
      jobId: interrupted.jobId,
      action: "finished",
      job,
      status: "error",
      error: STARTUP_INTERRUPTED_ERROR,
      delivered: false,
      deliveryStatus: "unknown",
      deliveryError: STARTUP_INTERRUPTED_ERROR,
      failureNotificationDelivery: job ? failureNotificationDeliveryFromJobState(job) : undefined,
      runAtMs: interrupted.runAtMs,
      durationMs: interrupted.durationMs,
      nextRunAtMs: job?.state.nextRunAtMs,
    },
    undefined,
    interrupted.taskRunId,
  );
}

function stopForeignReceiptReconciliation(state: CronServiceState, clear: boolean): void {
  const monitor = foreignReceiptMonitor(state);
  if (monitor.timer) {
    clearTimeout(monitor.timer);
    monitor.timer = null;
  }
  if (clear) {
    monitor.startedAtByJobId.clear();
  }
}

function armForeignReceiptReconciliation(state: CronServiceState): void {
  const monitor = foreignReceiptMonitor(state);
  if (
    state.stopped ||
    state.schedulingPaused ||
    monitor.timer ||
    monitor.startedAtByJobId.size === 0
  ) {
    return;
  }
  monitor.timer = setTimeout(() => {
    monitor.timer = null;
    void reconcileForeignRunReceipts(state)
      .catch((error: unknown) => {
        state.deps.log.warn(
          { err: String(error) },
          "cron: foreign run receipt reconciliation failed",
        );
      })
      .finally(() => armForeignReceiptReconciliation(state));
  }, CRON_FOREIGN_RECEIPT_RECHECK_MS);
  monitor.timer.unref?.();
}

async function reconcileForeignRunReceipts(state: CronServiceState): Promise<void> {
  const monitor = foreignReceiptMonitor(state);
  let schedulingChanged = false;
  await locked(state, async () => {
    if (state.stopped || monitor.startedAtByJobId.size === 0) {
      return;
    }
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const candidates: Array<{
      jobId: string;
      runningAtMs: number;
      finalized: FinalizedCronTaskRun;
    }> = [];
    for (const [jobId, runningAtMs] of [...monitor.startedAtByJobId.entries()].toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (job?.state.runningAtMs !== runningAtMs) {
        if (typeof job?.state.runningAtMs === "number") {
          monitor.startedAtByJobId.set(jobId, job.state.runningAtMs);
        } else {
          monitor.startedAtByJobId.delete(jobId);
        }
        schedulingChanged = true;
        continue;
      }
      // The store helper observes process liveness before entering SQLite, then
      // retires only that exact receipt owner inside its write transaction.
      const finalized = tryFindFinalizedCronTaskRun(state, jobId, runningAtMs);
      if (
        !reconcileCronRunReceiptForStartup({
          storePath: state.deps.storePath,
          jobId,
          startedAtMs: runningAtMs,
          nowMs: state.deps.nowMs(),
        })
      ) {
        candidates.push({ jobId, runningAtMs, finalized });
      }
    }
    if (candidates.length === 0) {
      return;
    }

    // A foreign owner may have terminalized after the liveness observation.
    // Reload once and repair only markers that still identify the observed run.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const rollbackSnapshot = snapshotStoreForRollback(state);
    const completedJobIdsToDelete = new Set<string>();
    const interruptedRuns: InterruptedStartupRun[] = [];
    const receiptCorrections: RecoveredReceiptCorrection[] = [];
    const recoveredJobIds: string[] = [];
    const postPersistNotifications: DeferredCronNotifications = [];
    for (const { jobId, runningAtMs, finalized } of candidates) {
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (job?.state.runningAtMs !== runningAtMs) {
        if (typeof job?.state.runningAtMs === "number") {
          monitor.startedAtByJobId.set(jobId, job.state.runningAtMs);
        } else {
          monitor.startedAtByJobId.delete(jobId);
        }
        schedulingChanged = true;
        continue;
      }
      const recovery = repairStoppedCronRun({
        state,
        job,
        runningAtMs,
        finalized,
        deferredNotifications: postPersistNotifications,
      });
      if (recovery.shouldDelete) {
        completedJobIdsToDelete.add(jobId);
      }
      if (recovery.interrupted) {
        interruptedRuns.push(recovery.interrupted);
      }
      if (recovery.receiptCorrection) {
        receiptCorrections.push(recovery.receiptCorrection);
      }
      recoveredJobIds.push(jobId);
    }
    if (recoveredJobIds.length === 0) {
      return;
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = state.store.jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    recomputeNextRunsForMaintenance(state, {
      recomputeExpired: true,
      deferredNotifications: postPersistNotifications,
    });
    await persistOrRestore(state, rollbackSnapshot, {
      postPersistNotifications,
      transactionHooks: recoveredReceiptHooks(state, receiptCorrections),
    });
    for (const jobId of recoveredJobIds) {
      monitor.startedAtByJobId.delete(jobId);
    }
    pruneCronJobScratchAfterCommit(state, completedJobIdsToDelete);
    for (const interrupted of interruptedRuns) {
      emitInterruptedRun(state, interrupted);
    }
    schedulingChanged = true;
  });
  if (schedulingChanged) {
    armTimer(state);
  }
}

/** Starts the cron service, recovers interrupted runs, catches up missed jobs, and arms the timer. */
export async function start(state: CronServiceState): Promise<void> {
  state.stopped = false;
  stopForeignReceiptReconciliation(state, true);
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedJobIds = new Set<string>();
  const interruptedRuns: InterruptedStartupRun[] = [];
  const receiptCorrections: RecoveredReceiptCorrection[] = [];
  const completedJobIdsToDelete = new Set<string>();
  let repairedAnyStartupRun = false;
  let restartStartupRecovery = false;
  const postPersistNotifications: DeferredCronNotifications = [];
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    if (state.deps.legacyDefaultAgentId) {
      const rewritten = materializeLegacyDefaultCronJobOwners({
        storePath: state.deps.storePath,
        legacyDefaultAgentId: state.deps.legacyDefaultAgentId,
      });
      if (rewritten > 0) {
        state.deps.log.info(
          { storePath: state.deps.storePath, rewritten },
          "cron: assigned legacy jobs to the retained owner",
        );
        // The first load can import legacy JSON into SQLite. Refresh the runtime
        // snapshot after ownership is committed and before any job can run.
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      }
    }
    if (state.stopped) {
      return;
    }
    const recoveryCandidates: Array<{
      jobId: string;
      runningAtMs: number;
      finalized: FinalizedCronTaskRun;
    }> = [];
    for (const job of state.store?.jobs ?? []) {
      if (typeof job.state.runningAtMs !== "number") {
        continue;
      }
      const runningAtMs = job.state.runningAtMs;
      const finalized = tryFindFinalizedCronTaskRun(state, job.id, runningAtMs);
      if (
        reconcileCronRunReceiptForStartup({
          storePath: state.deps.storePath,
          jobId: job.id,
          startedAtMs: runningAtMs,
          nowMs: state.deps.nowMs(),
        })
      ) {
        foreignReceiptMonitor(state).startedAtByJobId.set(job.id, runningAtMs);
        interruptedJobIds.add(job.id);
      } else {
        recoveryCandidates.push({ jobId: job.id, runningAtMs, finalized });
      }
    }
    if (recoveryCandidates.length > 0) {
      // A falsey receipt query can mean the foreign owner just committed. Reload
      // every runtime row before applying any queued-marker or recovery mutation.
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    }
    for (const job of state.store?.jobs ?? []) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        state.deps.log.info(
          { jobId: job.id, queuedAtMs: job.state.queuedAtMs },
          "cron: releasing queued job reservation on startup",
        );
        job.state.queuedAtMs = undefined;
        repairedAnyStartupRun = true;
      }
    }
    for (const { jobId, runningAtMs, finalized } of recoveryCandidates) {
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (job?.state.runningAtMs !== runningAtMs) {
        restartStartupRecovery = true;
        return;
      }
      const recovery = repairStoppedCronRun({
        state,
        job,
        runningAtMs,
        finalized,
        deferredNotifications: postPersistNotifications,
      });
      if (recovery.replacementAtMs === undefined) {
        interruptedJobIds.add(job.id);
      }
      if (recovery.shouldDelete) {
        completedJobIdsToDelete.add(job.id);
      }
      if (recovery.interrupted) {
        interruptedRuns.push(recovery.interrupted);
      }
      if (recovery.receiptCorrection) {
        receiptCorrections.push(recovery.receiptCorrection);
      }
      repairedAnyStartupRun = true;
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = state.store.jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    if (repairedAnyStartupRun || (state.store?.jobs.length ?? 0) > 0) {
      // Recovery notifications describe repaired durable rows, so never
      // publish them until the startup write has committed successfully.
      const persisted = await persist(state, {
        ...(repairedAnyStartupRun ? {} : { stateOnly: true }),
        postPersistNotifications,
        transactionHooks: recoveredReceiptHooks(state, receiptCorrections),
      });
      if (persisted) {
        pruneCronJobScratchAfterCommit(state, completedJobIdsToDelete);
      }
    }
  });

  if (restartStartupRecovery) {
    if (!state.stopped) {
      await start(state);
    }
    return;
  }

  if (state.stopped) {
    return;
  }
  await runMissedJobs(state, {
    skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : undefined,
    deferAgentTurnJobs: true,
  });

  await locked(state, async () => {
    // Startup catch-up already persisted the latest in-memory store state, and
    // this path runs before the scheduler begins servicing regular timer ticks.
    // Avoid an extra reload/write cycle on startup.
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    const postPersistMaintenanceNotifications: DeferredCronNotifications = [];
    const changed = recomputeNextRunsForMaintenance(state, {
      recomputeExpired: true,
      deferredNotifications: postPersistMaintenanceNotifications,
    });
    if (changed) {
      await persist(state, {
        postPersistNotifications: postPersistMaintenanceNotifications,
      });
    }
    for (const interrupted of interruptedRuns) {
      emitInterruptedRun(state, interrupted);
    }
    armTimer(state);
    armForeignReceiptReconciliation(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  state.stopped = true;
  cancelCronRunAdmissionWaiters(state);
  state.schedulerStarted = false;
  stopForeignReceiptReconciliation(state, true);
  stopTimer(state);
}

/** Temporarily stops automatic ticks without running startup recovery on resume. */
export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  stopForeignReceiptReconciliation(state, false);
  stopTimer(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (!state.schedulerStarted) {
    return;
  }
  try {
    armTimer(state);
    armForeignReceiptReconciliation(state);
  } catch (err) {
    // armTimer can install a timer before a later dependency throws. Roll the
    // whole transition back so a suspension retry cannot reopen without cron.
    state.schedulingPaused = true;
    stopTimer(state);
    throw err;
  }
}
