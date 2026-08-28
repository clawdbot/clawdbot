import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../store/row-codec.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  inspectActiveCronRunReceipt,
  isCronRunReceiptOwnerStale,
  type CronRunReceiptRecoveryCandidate,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import {
  type CronMaintenanceOptions,
  recomputeJobNextRunAtMs,
  recomputeSingleJobForMaintenance,
} from "./jobs-scheduling.js";
import { resolveCronRunReceiptTerminalStatus } from "./run-receipts.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
} from "./startup-run-repair.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { findCronTaskRunRecoveryInDatabase } from "./task-runs.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryResult =
  | { kind: "live"; receipt: CronRunReceiptRecoveryCandidate }
  | { kind: "superseded"; receipt?: CronRunReceiptRecoveryCandidate }
  | {
      kind: "repaired";
      interrupted?: InterruptedStartupRun;
      notifications: DeferredCronNotifications;
      skipStartupCatchup?: boolean;
    };

function exactReceiptMatches(
  current: CronRunReceiptRecoveryCandidate | undefined,
  proposed: CronRunReceiptRecoveryCandidate,
): boolean {
  return (
    current?.receiptId === proposed.receiptId &&
    current.ownerPid === proposed.ownerPid &&
    current.ownerStartTime === proposed.ownerStartTime &&
    current.storeKey === proposed.storeKey &&
    current.jobId === proposed.jobId &&
    current.startedAtMs === proposed.startedAtMs
  );
}

function repairInDatabase(params: {
  state: CronServiceState;
  database: OpenClawStateDatabase;
  proposal: CronRunRecoveryProposal;
  proposedReceiptIsStale: boolean;
}): CronRunRecoveryResult {
  const { state, database, proposal } = params;
  const storeKey = cronStoreKey(state.deps.storePath);
  const currentReceipt = findActiveCronRunReceiptInDatabase({
    database: database.db,
    storePath: state.deps.storePath,
    jobId: proposal.jobId,
  });
  if (proposal.receipt) {
    // Receipt identity is the recovery CAS. The millisecond marker is checked
    // only after this succeeds because successive runs may share a timestamp.
    if (!exactReceiptMatches(currentReceipt, proposal.receipt) && currentReceipt) {
      return { kind: "superseded", receipt: currentReceipt };
    }
    if (currentReceipt && !params.proposedReceiptIsStale) {
      return { kind: "live", receipt: currentReceipt };
    }
  } else if (currentReceipt) {
    return { kind: "superseded", receipt: currentReceipt };
  }

  const rows = loadCronRows(database.db, storeKey);
  const row = rows.find((entry) => entry.job_id === proposal.jobId);
  const job = row
    ? loadedCronStoreFromRows([row]).store.jobs.find((entry) => entry.id === proposal.jobId)
    : undefined;
  if (!row || !job) {
    if (proposal.receipt && currentReceipt) {
      finishCronRunReceiptInDatabase({
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after the job row was finalized",
      });
      return { kind: "repaired", notifications: [] };
    }
    return { kind: "superseded" };
  }
  let changed = false;
  if (proposal.queuedAtMs !== undefined && job.state.queuedAtMs === proposal.queuedAtMs) {
    delete job.state.queuedAtMs;
    if (proposal.receipt && currentReceipt) {
      finishCronRunReceiptInDatabase({
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: queued run interrupted because owner is unavailable",
      });
    }
    changed = true;
  }
  let interrupted: InterruptedStartupRun | undefined;
  let replacementAtMs: number | undefined;
  const notifications: DeferredCronNotifications = [];
  if (proposal.runningAtMs !== undefined) {
    if (job.state.runningAtMs !== proposal.runningAtMs) {
      if (proposal.receipt && currentReceipt) {
        finishCronRunReceiptInDatabase({
          database: database.db,
          handle: proposal.receipt,
          status: "interrupted",
          finishedAtMs: state.deps.nowMs(),
          error: "cron: owner unavailable after run state was already finalized",
        });
        return { kind: "repaired", notifications: [] };
      }
      return { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) };
    }
    const task = findCronTaskRunRecoveryInDatabase({
      database: database.db,
      jobId: proposal.jobId,
      startedAt: proposal.runningAtMs,
      storeKey,
      receiptId: proposal.receipt?.receiptId,
    });
    const finalized = task.finalized;
    const restored = finalized
      ? restoreFinalizedStartupRun({
          state,
          job,
          runningAtMs: proposal.runningAtMs,
          entry: finalized.entry,
          ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
          ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
          deferredNotifications: notifications,
        })
      : undefined;
    replacementAtMs = restored?.replacementAtMs;
    if (!restored) {
      const nowMs = state.deps.nowMs();
      interrupted = markInterruptedStartupRun({
        state,
        job,
        taskRunId: task.taskRunId,
        runningAtMs: proposal.runningAtMs,
        nowMs,
        deferredNotifications: notifications,
      });
      replacementAtMs = interrupted.replacementAtMs;
      if (job.enabled && job.state.nextRunAtMs === undefined) {
        recomputeJobNextRunAtMs({
          state,
          job,
          nowMs,
          deferredNotifications: notifications,
        });
      }
    }
    if (proposal.receipt) {
      finishCronRunReceiptInDatabase({
        database: database.db,
        handle: proposal.receipt,
        status:
          restored && finalized
            ? resolveCronRunReceiptTerminalStatus(
                finalized.entry.status,
                finalized.triggerEval?.fired,
              )
            : "interrupted",
        finishedAtMs: restored && finalized ? finalized.entry.ts : state.deps.nowMs(),
        error:
          restored && finalized
            ? finalized.entry.error
            : "cron: job interrupted because owner is unavailable",
      });
    }
    if (restored?.shouldDelete) {
      deleteCronJobRowInDatabase(database.db, storeKey, proposal.jobId);
      return {
        kind: "repaired",
        notifications,
        ...(restored.replacementAtMs === undefined ? { skipStartupCatchup: true } : {}),
      };
    }
    changed = true;
  }
  if (!changed) {
    if (proposal.receipt && currentReceipt && params.proposedReceiptIsStale) {
      finishCronRunReceiptInDatabase({
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after run marker retirement",
      });
      return { kind: "repaired", notifications };
    }
    return { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) };
  }
  upsertCronJobRow(database.db, storeKey, job, row.sort_order);
  return {
    kind: "repaired",
    ...(interrupted ? { interrupted } : {}),
    notifications,
    ...(replacementAtMs === undefined && proposal.runningAtMs !== undefined
      ? { skipStartupCatchup: true }
      : {}),
  };
}

export function proposeCronRunRecovery(
  state: CronServiceState,
  jobId: string,
  queuedAtMs: number | undefined,
  runningAtMs: number | undefined,
): CronRunRecoveryProposal {
  return {
    jobId,
    ...(queuedAtMs !== undefined ? { queuedAtMs } : {}),
    ...(queuedAtMs !== undefined || runningAtMs !== undefined
      ? {
          receipt: inspectActiveCronRunReceipt({ storePath: state.deps.storePath, jobId }),
        }
      : {}),
    ...(runningAtMs !== undefined ? { runningAtMs } : {}),
  };
}

/** Reconciles the bounded durable marker set so live siblings can adopt dead owners. */
export function recoverNonTerminalCronRunReceipts(state: CronServiceState): {
  repaired: boolean;
  receipts: CronRunReceiptRecoveryCandidate[];
  notifications: DeferredCronNotifications;
} {
  let repaired = false;
  const receipts: CronRunReceiptRecoveryCandidate[] = [];
  const notifications: DeferredCronNotifications = [];
  for (const job of state.store?.jobs ?? []) {
    const queuedAtMs = job.state.queuedAtMs;
    const runningAtMs = job.state.runningAtMs;
    if (queuedAtMs === undefined && runningAtMs === undefined) {
      continue;
    }
    const proposal = proposeCronRunRecovery(state, job.id, queuedAtMs, runningAtMs);
    const result = recoverCronRunProposal(state, proposal);
    if (result.kind === "live") {
      if (result.receipt.ownerPid !== process.pid) {
        receipts.push(result.receipt);
      }
    } else if (result.kind === "superseded") {
      if (result.receipt && result.receipt.ownerPid !== process.pid) {
        receipts.push(result.receipt);
      }
    } else {
      repaired = true;
      notifications.push(...result.notifications);
    }
  }
  return { repaired, receipts, notifications };
}

export function recoverCronRunProposal(
  state: CronServiceState,
  proposal: CronRunRecoveryProposal,
): CronRunRecoveryResult {
  // Process liveness is observed before taking SQLite's write lock, but the
  // transaction decides only after proving this exact receipt is still active.
  const proposedReceiptIsStale = proposal.receipt
    ? isCronRunReceiptOwnerStale(proposal.receipt, state.deps.nowMs())
    : true;
  const result = runOpenClawStateWriteTransaction(
    (database) => repairInDatabase({ state, database, proposal, proposedReceiptIsStale }),
    {},
    { operationLabel: "cron.run-recovery" },
  );
  if (result.kind === "repaired") {
    noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
  }
  return result;
}

/** Schedules only authoritative rows that are not protected by an active run. */
export function recomputeUnownedCronSchedules(
  state: CronServiceState,
  opts?: Omit<CronMaintenanceOptions, "deferredNotifications">,
): {
  changed: boolean;
  jobs: CronJob[];
  notifications: DeferredCronNotifications;
} {
  const storeKey = cronStoreKey(state.deps.storePath);
  const nowMs = state.deps.nowMs();
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const notifications: DeferredCronNotifications = [];
      let changed = false;
      const jobs: CronJob[] = [];
      for (const row of loadCronRows(db, storeKey)) {
        if (
          findActiveCronRunReceiptInDatabase({
            database: db,
            storePath: state.deps.storePath,
            jobId: row.job_id,
          })
        ) {
          continue;
        }
        const job = loadedCronStoreFromRows([row]).store.jobs[0];
        if (!job) {
          continue;
        }
        if (
          recomputeSingleJobForMaintenance(state, job, {
            ...opts,
            nowMs: opts?.nowMs ?? nowMs,
            deferredNotifications: notifications,
          })
        ) {
          upsertCronJobRow(db, storeKey, job, row.sort_order);
          jobs.push(job);
          changed = true;
        }
      }
      return { changed, jobs, notifications };
    },
    {},
    { operationLabel: "cron.schedule-unowned" },
  );
  if (result.changed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return result;
}
