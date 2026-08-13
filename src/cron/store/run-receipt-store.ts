import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";

type CronRunReceiptDatabase = Pick<OpenClawStateDatabase, "cron_run_receipts">;
type CronRunReceiptRow = Selectable<CronRunReceiptDatabase["cron_run_receipts"]>;

export type CronRunReceiptStatus =
  | "running"
  | "ok"
  | "error"
  | "skipped"
  | "interrupted"
  | "superseded";

type CronRunReceipt = {
  receiptId: string;
  storeKey: string;
  jobId: string;
  configRevision: string;
  agentId: string;
  requestRunId?: string;
  status: CronRunReceiptStatus;
  ownerPid: number;
  ownerStartTime: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  error?: string;
};

export type CronRunReceiptHandle = Pick<
  CronRunReceipt,
  | "agentId"
  | "configRevision"
  | "jobId"
  | "ownerPid"
  | "ownerStartTime"
  | "receiptId"
  | "startedAtMs"
  | "storeKey"
>;

type ResolveReceiptAgentId = (job: CronJob) => string;

const CRON_RUN_RECEIPT_SCHEMA_START = "CREATE TABLE IF NOT EXISTS cron_run_receipts (";
const CRON_RUN_RECEIPT_SCHEMA_END =
  "ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);";
const initializedDatabases = new WeakSet<DatabaseSync>();
const locallyOwnedReceipts = new Set<string>();

export class CronRunReceiptConflictError extends Error {
  constructor(readonly receipt: CronRunReceipt) {
    super(`cron job ${receipt.jobId} is already running in process ${receipt.ownerPid}`);
    this.name = "CronRunReceiptConflictError";
  }
}

export class CronRunReceiptRevisionError extends Error {
  constructor(
    readonly receiptId: string,
    message = "cron run configuration changed",
  ) {
    super(message);
    this.name = "CronRunReceiptRevisionError";
  }
}

function ensureCronRunReceiptSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CRON_RUN_RECEIPT_SCHEMA_START);
  const endMarker = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CRON_RUN_RECEIPT_SCHEMA_END, start);
  if (start < 0 || endMarker < start) {
    throw new Error("OpenClaw cron run receipt schema marker is missing.");
  }
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarker + CRON_RUN_RECEIPT_SCHEMA_END.length),
  ); // sqlite-allow-raw -- Canonical feature-local additive DDL only.
}

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(database);
}

function withReceiptWrite<T>(
  operationLabel: string,
  options: OpenClawStateDatabaseOptions,
  operation: (database: DatabaseSync) => T,
): T {
  let initializedDatabase: DatabaseSync | undefined;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!initializedDatabases.has(db)) {
        ensureCronRunReceiptSchema(db);
        initializedDatabase = db;
      }
      return operation(db);
    },
    options,
    { operationLabel },
  );
  if (initializedDatabase) {
    initializedDatabases.add(initializedDatabase);
  }
  return result;
}

function isReceiptStatus(value: string): value is CronRunReceiptStatus {
  return (
    value === "running" ||
    value === "ok" ||
    value === "error" ||
    value === "skipped" ||
    value === "interrupted" ||
    value === "superseded"
  );
}

function receiptFromRow(row: CronRunReceiptRow): CronRunReceipt {
  if (!isReceiptStatus(row.status)) {
    throw new Error(`invalid cron run receipt status ${row.status}`);
  }
  return {
    receiptId: row.receipt_id,
    storeKey: row.store_key,
    jobId: row.job_id,
    configRevision: row.config_revision,
    agentId: row.agent_id,
    ...(row.request_run_id ? { requestRunId: row.request_run_id } : {}),
    status: row.status,
    ownerPid: row.owner_pid,
    ownerStartTime: row.owner_start_time,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    ...(row.error_text ? { error: row.error_text } : {}),
  };
}

function activeRow(database: DatabaseSync, storeKey: string, jobId: string) {
  return executeSqliteQueryTakeFirstSync(
    database,
    query(database)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId)
      .where("status", "=", "running"),
  );
}

function currentJob(database: DatabaseSync, storeKey: string, jobId: string): CronJob | undefined {
  const rows = loadCronRows(database, storeKey);
  if (rows.length === 0) {
    return undefined;
  }
  return loadedCronStoreFromRows(rows).store.jobs.find((job) => job.id === jobId);
}

function sameOwner(left: CronRunReceiptRow, right: CronRunReceiptRow): boolean {
  return (
    left.receipt_id === right.receipt_id &&
    left.owner_pid === right.owner_pid &&
    left.owner_start_time === right.owner_start_time &&
    left.status === right.status
  );
}

function ownerDefinitelyStale(row: CronRunReceiptRow): boolean {
  if (row.owner_pid === process.pid) {
    return !locallyOwnedReceipts.has(row.receipt_id);
  }
  if (isPidDefinitelyDead(row.owner_pid)) {
    return true;
  }
  const observedStartTime = getFileLockProcessStartTime(row.owner_pid);
  return (
    row.owner_start_time !== null &&
    observedStartTime !== null &&
    row.owner_start_time !== observedStartTime
  );
}

function validateCurrentJob(params: {
  database: DatabaseSync;
  handle: Pick<
    CronRunReceiptHandle,
    "agentId" | "configRevision" | "jobId" | "receiptId" | "storeKey"
  >;
  resolveAgentId: ResolveReceiptAgentId;
}): CronJob {
  const job = currentJob(params.database, params.handle.storeKey, params.handle.jobId);
  if (!job) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId, "cron job was removed");
  }
  if (params.resolveAgentId(job) !== params.handle.agentId) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId);
  }
  return job;
}

function receiptHandle(receipt: CronRunReceipt): CronRunReceiptHandle {
  return {
    receiptId: receipt.receiptId,
    storeKey: receipt.storeKey,
    jobId: receipt.jobId,
    configRevision: receipt.configRevision,
    agentId: receipt.agentId,
    ownerPid: receipt.ownerPid,
    ownerStartTime: receipt.ownerStartTime,
    startedAtMs: receipt.startedAtMs,
  };
}

/** Atomically records a run start and acquires the one-active-run durable fence. */
export function claimCronRunReceipt(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
  resolveAgentId: ResolveReceiptAgentId;
  env?: NodeJS.ProcessEnv;
}): CronRunReceiptHandle {
  const storeKey = cronStoreKey(params.storePath);
  const options = params.env ? { env: params.env } : {};
  const observed = withReceiptWrite("cron.run-receipt.inspect", options, (database) =>
    activeRow(database, storeKey, params.job.id),
  );
  const observedStale = observed ? ownerDefinitelyStale(observed) : false;
  const receiptId = crypto.randomUUID();
  const handle: CronRunReceiptHandle = {
    receiptId,
    storeKey,
    jobId: params.job.id,
    configRevision: resolveCronJobConfigRevision(params.job),
    agentId: params.agentId,
    ownerPid: process.pid,
    ownerStartTime: getFileLockProcessStartTime(process.pid),
    startedAtMs: params.startedAtMs,
  };

  const claimed = withReceiptWrite("cron.run-receipt.claim", options, (database) => {
    const current = activeRow(database, storeKey, params.job.id);
    if (current) {
      if (observed && observedStale && sameOwner(current, observed)) {
        executeSqliteQuerySync(
          database,
          query(database)
            .updateTable("cron_run_receipts")
            .set({
              status: "interrupted",
              finished_at_ms: params.startedAtMs,
              error_text: "cron: job interrupted by owner process exit",
            })
            .where("receipt_id", "=", current.receipt_id)
            .where("status", "=", "running"),
        );
      } else {
        throw new CronRunReceiptConflictError(receiptFromRow(current));
      }
    }
    validateCurrentJob({ database, handle, resolveAgentId: params.resolveAgentId });
    executeSqliteQuerySync(
      database,
      query(database)
        .insertInto("cron_run_receipts")
        .values({
          receipt_id: receiptId,
          store_key: storeKey,
          job_id: params.job.id,
          config_revision: handle.configRevision,
          agent_id: params.agentId,
          request_run_id: params.requestRunId ?? null,
          status: "running",
          owner_pid: handle.ownerPid,
          owner_start_time: handle.ownerStartTime,
          started_at_ms: params.startedAtMs,
          finished_at_ms: null,
          error_text: null,
        }),
    );
    return receiptHandle(receiptFromRow(activeRow(database, storeKey, params.job.id)!));
  });
  locallyOwnedReceipts.add(claimed.receiptId);
  return claimed;
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptCurrentInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
}): void {
  const current = activeRow(params.database, params.handle.storeKey, params.handle.jobId);
  if (
    !current ||
    current.receipt_id !== params.handle.receiptId ||
    current.owner_pid !== params.handle.ownerPid ||
    current.owner_start_time !== params.handle.ownerStartTime
  ) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      "cron run fence is no longer current",
    );
  }
  validateCurrentJob({
    database: params.database,
    handle: params.handle,
    resolveAgentId: params.resolveAgentId,
  });
}

export function assertCronRunReceiptCurrent(params: {
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
  isAgentAvailable?: (agentId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  if (params.isAgentAvailable && !params.isAgentAvailable(params.handle.agentId)) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      `cron run owner ${params.handle.agentId} is no longer configured`,
    );
  }
  withReceiptWrite(
    "cron.run-receipt.assert-current",
    params.env ? { env: params.env } : {},
    (database) =>
      assertCronRunReceiptCurrentInDatabase({
        database,
        handle: params.handle,
        resolveAgentId: params.resolveAgentId,
      }),
  );
}

export function finishCronRunReceipt(params: {
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
  env?: NodeJS.ProcessEnv;
}): CronRunReceipt | undefined {
  const finished = withReceiptWrite(
    "cron.run-receipt.finish",
    params.env ? { env: params.env } : {},
    (database) => finishCronRunReceiptInDatabase({ database, ...params }),
  );
  locallyOwnedReceipts.delete(params.handle.receiptId);
  return finished;
}

/** Releases only this process's liveness proof after terminal persistence fails. */
export function releaseLocalCronRunReceiptOwnership(handle: CronRunReceiptHandle): void {
  locallyOwnedReceipts.delete(handle.receiptId);
}

/** Completes the exact active receipt inside its caller's cron-state transaction. */
export function finishCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
}): CronRunReceipt | undefined {
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({
        status: params.status,
        finished_at_ms: params.finishedAtMs,
        error_text: params.error ?? null,
      })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running")
      .where("owner_pid", "=", params.handle.ownerPid),
  );
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    query(params.database)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("receipt_id", "=", params.handle.receiptId),
  );
  return row ? receiptFromRow(row) : undefined;
}

/** Returns a still-live foreign claim, or retires a provably stale owner. */
export function reconcileCronRunReceiptForStartup(params: {
  storePath: string;
  jobId: string;
  startedAtMs: number;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): CronRunReceipt | undefined {
  const storeKey = cronStoreKey(params.storePath);
  const options = params.env ? { env: params.env } : {};
  const observed = withReceiptWrite("cron.run-receipt.startup-inspect", options, (database) =>
    activeRow(database, storeKey, params.jobId),
  );
  if (!observed || observed.started_at_ms !== params.startedAtMs) {
    return undefined;
  }
  const stale = ownerDefinitelyStale(observed);
  return withReceiptWrite("cron.run-receipt.startup-reconcile", options, (database) => {
    const current = activeRow(database, storeKey, params.jobId);
    if (!current || !sameOwner(current, observed) || current.started_at_ms !== params.startedAtMs) {
      return current ? receiptFromRow(current) : undefined;
    }
    if (!stale) {
      return receiptFromRow(current);
    }
    executeSqliteQuerySync(
      database,
      query(database)
        .updateTable("cron_run_receipts")
        .set({
          status: "interrupted",
          finished_at_ms: params.nowMs,
          error_text: "cron: job interrupted by owner process exit",
        })
        .where("receipt_id", "=", current.receipt_id)
        .where("status", "=", "running"),
    );
    return undefined;
  });
}
