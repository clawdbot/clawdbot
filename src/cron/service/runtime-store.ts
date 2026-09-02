import type { DatabaseSync } from "node:sqlite";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "../store/runtime-authority-store.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob, CronStoredJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { publishCronRuntimeRows } from "./store.js";

type CronRuntimeMutation<T> = {
  deleteJobIds?: Iterable<string>;
  runHooks?: boolean;
  upsertJobIds?: Iterable<string>;
  value: T;
};

/** Applies committed target rows locally without copying any unrelated store snapshot. */
export function applyCronRuntimeRowsToState(
  state: CronServiceState,
  jobs: Iterable<CronJob>,
  deletedJobIds: Iterable<string> = [],
  opts?: { publish?: boolean },
): void {
  if (!state.store) {
    return;
  }
  const jobsById = new Map([...jobs].map((job) => [job.id, job] as const));
  const deleted = new Set(deletedJobIds);
  const residentJobIds = new Set(state.store.jobs.map((job) => job.id));
  const residentJobs = state.store.jobs
    .filter((job) => !deleted.has(job.id))
    .map((job) => jobsById.get(job.id) ?? job);
  const importedJobs = [...jobsById.values()].filter(
    (job) => !residentJobIds.has(job.id) && !deleted.has(job.id),
  );
  state.store.jobs = [...residentJobs, ...importedJobs];
  if (opts?.publish !== false) {
    publishCronRuntimeRows(state);
  }
}

/** Commits runtime-owned job rows from authoritative values read under SQLite's write lock. */
export function commitCronRuntimeRows<T>(params: {
  state: CronServiceState;
  jobIds: Iterable<string>;
  operationLabel: string;
  transactionHooks?: CronStoreTransactionHooks;
  mutate: (context: {
    database: DatabaseSync;
    jobs: ReadonlyMap<string, CronStoredJob>;
  }) => CronRuntimeMutation<T>;
}): T {
  const storeKey = cronStoreKey(params.state.deps.storePath);
  const jobIds = new Set(params.jobIds);
  const committed = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, storeKey).filter((row) => jobIds.has(row.job_id));
      const rowsByJobId = new Map(rows.map((row) => [row.job_id, row] as const));
      const loadedJobs = loadedCronStoreFromRows(rows).store.jobs;
      const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey, jobs: loadedJobs });
      if (repairJobIds.length > 0) {
        repairCronRuntimeAuthorityRows({
          db,
          storeKey,
          jobs: loadedJobs,
          jobIds: repairJobIds,
        });
      }
      const jobs = new Map(loadedJobs.map((job) => [job.id, job] as const));
      const mutation = params.mutate({ database: db, jobs });
      const upsertJobIds = [...new Set(mutation.upsertJobIds ?? [])].toSorted();
      const deleteJobIds = [...new Set(mutation.deleteJobIds ?? [])].toSorted();
      const runHooks = mutation.runHooks !== false;
      if (runHooks) {
        params.transactionHooks?.beforeWrite?.(db);
      }
      for (const jobId of deleteJobIds) {
        deleteCronJobRowInDatabase(db, storeKey, jobId);
      }
      for (const jobId of upsertJobIds) {
        const row = rowsByJobId.get(jobId);
        const job = jobs.get(jobId);
        if (row && job && !deleteJobIds.includes(jobId)) {
          upsertCronJobRow(db, storeKey, job, row.sort_order);
        }
      }
      if (runHooks) {
        params.transactionHooks?.afterWrite?.(db);
      }
      return {
        changed: upsertJobIds.length > 0 || deleteJobIds.length > 0,
        runHooks,
        value: mutation.value,
      };
    },
    {},
    { operationLabel: params.operationLabel },
  );
  if (committed.runHooks) {
    params.transactionHooks?.afterCommit?.();
  }
  if (committed.changed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return committed.value;
}
