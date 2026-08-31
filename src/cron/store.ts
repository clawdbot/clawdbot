/** Public cron store load/save API backed entirely by shared SQLite state. */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expandHomePrefix } from "../infra/home-dir.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { readCronStoreStatePath } from "./store/config-state.js";
import { cronStoreKey } from "./store/key.js";
import {
  deleteCronQuarantinedJobsFromDatabase,
  saveCronQuarantinedJobs,
} from "./store/quarantine.js";
import {
  assertCronStoreCanPersist,
  deleteStaleCronJobFamilyRows,
  loadedCronStoreFromRows,
  loadCronRows,
  replaceCronRows,
  updateCronRuntimeRows,
} from "./store/row-codec.js";
import type { CronJobFamilyIdentity } from "./store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
  replaceCronRuntimeAuthorityRows,
} from "./store/runtime-authority-store.js";
import type { CronStoreTransactionHooks } from "./store/transaction-hooks.types.js";
import type {
  CronQuarantinedJob,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "./store/types.js";
import type { CronStoreFile } from "./types.js";
export type {
  CronConfigJobRuntimeEntry,
  CronQuarantinedJob,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "./store/types.js";
export { loadCronQuarantinedJobs, saveCronQuarantinedJobs } from "./store/quarantine.js";

const MAX_TRACKED_CRON_STORE_REVISIONS = 64;
const cronStoreRevisions = new Map<string, number>();
let nextCronStoreRevision = 0;

/** Reads the process-local committed revision for one canonical SQLite partition. */
export function getCronJobsStoreRevision(storePath: string): number {
  return cronStoreRevisions.get(cronStoreKey(storePath)) ?? 0;
}

export function noteCronJobsStoreCommit(storeKey: string): void {
  // A bounded monotonic fact invalidates sibling service snapshots without
  // polling SQLite or discarding the current scheduler's transient run state.
  cronStoreRevisions.delete(storeKey);
  cronStoreRevisions.set(storeKey, ++nextCronStoreRevision);
  pruneMapToMaxSize(cronStoreRevisions, MAX_TRACKED_CRON_STORE_REVISIONS);
}

function resolveDefaultCronDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "cron");
}

function resolveDefaultCronStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultCronDir(env), "jobs.json");
}

/** Resolves the cron jobs store path, expanding home-relative user input. */
export function resolveCronJobsStorePath(storePath?: string, env: NodeJS.ProcessEnv = process.env) {
  const selected = storePath?.trim() || readCronStoreStatePath(env);
  if (selected) {
    const raw = selected.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw, { env }));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath(env);
}

/** Resolves the active cron partition from runtime config and environment. */
export function resolveCronJobsStorePathFromConfig(
  cfg: { cron?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const store = (cfg.cron as { store?: unknown } | undefined)?.store;
  return resolveCronJobsStorePath(typeof store === "string" ? store : undefined, env);
}

/** Loads cron jobs plus config/runtime sidecars from the SQLite-backed store. */
export async function loadCronJobsStoreWithConfigJobs(storePath: string): Promise<LoadedCronStore> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    const loaded = loadedCronStoreFromRows(rows);
    const authority = loadCronRuntimeAuthorities({
      db: database,
      storeKey,
      jobs: loaded.store.jobs,
    });
    repairLoadedCronRuntimeAuthority({
      storeKey,
      jobIds: authority.repairJobIds,
    });
    return loaded;
  }
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

function repairLoadedCronRuntimeAuthority(params: {
  storeKey: string;
  jobIds: readonly string[];
}): void {
  if (params.jobIds.length === 0) {
    return;
  }
  const repaired = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, params.storeKey);
      if (rows.length === 0) {
        return false;
      }
      const loaded = loadedCronStoreFromRows(rows);
      return repairCronRuntimeAuthorityRows({
        db,
        storeKey: params.storeKey,
        jobs: loaded.store.jobs,
        jobIds: params.jobIds,
      });
    },
    {},
    { operationLabel: "cron.runtime-authority-repair" },
  );
  if (repaired) {
    noteCronJobsStoreCommit(params.storeKey);
  }
}

/** Removes an owned declarative job family left under obsolete absolute store keys. */
export function removeStaleCronJobFamilyRows(
  storePath: string,
  family: CronJobFamilyIdentity,
): number {
  const activeStoreKey = cronStoreKey(path.resolve(storePath));
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteStaleCronJobFamilyRows(db, activeStoreKey, family),
    {},
    { operationLabel: "cron.job-family-adoption" },
  );
}

function emptyLoadedCronStore(): LoadedCronStore {
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

/** Loads cron jobs from an existing SQLite store without creating or migrating state. */
export async function loadCronJobsStoreWithConfigJobsReadOnly(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return emptyLoadedCronStore();
  }
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const db = openNodeSqliteDatabase(statePath, { readOnly: true });
  try {
    if (!tableExists(db, "cron_jobs")) {
      return emptyLoadedCronStore();
    }
    const rows = loadCronRows(db, storeKey);
    if (rows.length > 0) {
      const loaded = loadedCronStoreFromRows(rows);
      loadCronRuntimeAuthorities({ db, storeKey, jobs: loaded.store.jobs });
      return loaded;
    }
    return emptyLoadedCronStore();
  } finally {
    db.close();
  }
}

/** Loads only the persisted cron job store payload. */
export async function loadCronJobsStore(storePath: string): Promise<CronStoreFile> {
  return (await loadCronJobsStoreWithConfigJobs(storePath)).store;
}

/** Synchronously loads only the persisted cron job store payload. */
export function loadCronJobsStoreSync(storePath: string): CronStoreFile {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    const loaded = loadedCronStoreFromRows(rows);
    const authority = loadCronRuntimeAuthorities({
      db: database,
      storeKey,
      jobs: loaded.store.jobs,
    });
    repairLoadedCronRuntimeAuthority({
      storeKey,
      jobIds: authority.repairJobIds,
    });
    return loaded.store;
  }
  return { version: 1, jobs: [] };
}

type SaveCronStoreOptions = {
  stateOnly?: boolean;
};

type SaveCronJobsStoreOptions = SaveCronStoreOptions & {
  quarantine?: {
    entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
    nowMs: number;
  };
  deleteQuarantineEntries?: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
};

type SaveCronJobsStoreInternalOptions = SaveCronJobsStoreOptions & {
  transactionHooks?: CronStoreTransactionHooks;
};

/** Persists cron jobs, or only mutable runtime state when stateOnly is set. */
export async function saveCronJobsStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronJobsStoreOptions,
): Promise<void>;
export async function saveCronJobsStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronJobsStoreInternalOptions,
): Promise<void> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const stateOnly =
    opts?.stateOnly === true &&
    !opts.quarantine?.entries.length &&
    !opts.deleteQuarantineEntries?.length;
  if (!stateOnly) {
    assertCronStoreCanPersist(store);
  }
  runOpenClawStateWriteTransaction((database) => {
    opts?.transactionHooks?.beforeWrite?.(database.db);
    if (opts?.quarantine?.entries.length) {
      saveCronQuarantinedJobs({
        storePath: resolvedStorePath,
        entries: opts.quarantine.entries,
        nowMs: opts.quarantine.nowMs,
        database,
      });
    }
    if (opts?.deleteQuarantineEntries?.length) {
      deleteCronQuarantinedJobsFromDatabase({
        database: database.db,
        storePath: resolvedStorePath,
        entries: opts.deleteQuarantineEntries,
      });
    }
    // Hot-path timer updates mutate runtime columns only; malformed-row
    // quarantine and full replacement commit together or roll back together.
    if (stateOnly) {
      updateCronRuntimeRows(database.db, storeKey, store);
      opts?.transactionHooks?.afterWrite?.(database.db);
      return;
    }
    const normalizedJobs = replaceCronRows(database.db, storeKey, store);
    replaceCronRuntimeAuthorityRows({ db: database.db, storeKey, jobs: normalizedJobs });
    opts?.transactionHooks?.afterWrite?.(database.db);
  });
  // Timeout outcomes may commit before their runner settles. Only after this
  // commit may a deferred receipt terminal request become externally visible.
  opts?.transactionHooks?.afterCommit?.();
  noteCronJobsStoreCommit(storeKey);
}

/** Atomically acquire doctor migration metadata and replace cron rows only for the winner. */
export async function saveCronJobsStoreWithMetadata(
  storePath: string,
  store: CronStoreFile,
  acquireMetadata: (db: DatabaseSync) => boolean,
  quarantine?: SaveCronJobsStoreOptions["quarantine"],
  deleteQuarantineEntries?: SaveCronJobsStoreOptions["deleteQuarantineEntries"],
): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  assertCronStoreCanPersist(store);
  const committed = runOpenClawStateWriteTransaction((database) => {
    if (!acquireMetadata(database.db)) {
      return false;
    }
    if (quarantine?.entries.length) {
      saveCronQuarantinedJobs({
        storePath: resolvedStorePath,
        entries: quarantine.entries,
        nowMs: quarantine.nowMs,
        database,
      });
    }
    if (deleteQuarantineEntries?.length) {
      deleteCronQuarantinedJobsFromDatabase({
        database: database.db,
        storePath: resolvedStorePath,
        entries: deleteQuarantineEntries,
      });
    }
    const normalizedJobs = replaceCronRows(database.db, storeKey, store);
    replaceCronRuntimeAuthorityRows({ db: database.db, storeKey, jobs: normalizedJobs });
    return true;
  });
  if (committed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return committed;
}

// Public plugin SDK seam; core callers use the SQLite-backed cron-jobs names above.
/** Resolves the public plugin-SDK cron store path. */
export function resolveCronStorePath(storePath?: string) {
  return resolveCronJobsStorePath(storePath);
}

/** Plugin-SDK alias for loading the cron store. */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return await loadCronJobsStore(storePath);
}

/** Plugin-SDK alias for saving the cron store. */
export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  await saveCronJobsStore(storePath, store, opts);
}
