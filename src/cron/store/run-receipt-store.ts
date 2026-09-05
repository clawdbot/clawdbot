import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  deleteExecutionOwnerLifecycleMetadata,
} from "../../audit/execution-owner-lifecycle-binding-store.js";
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

/**
 * Receipt/lease lifecycle (the SQLite status is `running` for the first three rows):
 *
 * State            | Transition owner       | Atomic durable change                         | Dead-owner recovery
 * reserved-queued  | reservation admission  | insert receipt + set job.queuedAtMs            | sibling interrupts receipt + clears exact queued marker
 * active-running   | execution admission    | advance receipt.startedAtMs + queued→running   | sibling interrupts receipt + repairs exact running marker
 * settling         | execution/finalizer    | outcome may be recorded; lease stays running   | sibling interrupts markerless receipt or restores finalized task fact
 * terminal{ok,error,skipped,interrupted,superseded}
 *                  | finalizer/recovery      | terminalize receipt with exact marker outcome  | no recovery; retained history is bounded
 *
 * I1: Every non-terminal receipt has a live owner or is recoverable by any live sibling.
 * I2: Receipt transitions and job markers commit together, or use the recovery rule above.
 * I3: Every abandon/cleanup path terminalizes and releases its exact receipt.
 * I4: Finalization applies outcomes to the authoritative row, never an admitted snapshot.
 */

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
export type CronRunReceiptRecoveryCandidate = CronRunReceiptHandle;

type ResolveReceiptAgentId = (job: CronJob) => string;

type CronRunReceiptOwnerObservation = {
  receiptId: string;
  ownerPid: number;
  ownerStartTime: number | null;
  startedAtMs: number;
};

type PreparedCronRunReceiptAdjudication = {
  storeKey: string;
  observed?: CronRunReceiptOwnerObservation;
  observedStale: boolean;
};

export type PreparedCronRunReceiptClaim = PreparedCronRunReceiptAdjudication & {
  handle: CronRunReceiptHandle;
  requestRunId?: string;
};

const CRON_RUN_RECEIPT_SCHEMA_START = "CREATE TABLE IF NOT EXISTS cron_run_receipts (";
const CRON_RUN_RECEIPT_SCHEMA_END =
  "ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);";
const CRON_RUN_RECEIPT_TERMINAL_RETENTION = 64;
const CRON_RUN_RECEIPT_DELETE_BATCH_SIZE = 500;
const CRON_RUN_RECEIPT_FINISH_RETRY_MS = 1_000;
/** Recovery horizon for abandoned markers and unverifiable foreign receipts. */
export const CRON_STUCK_RUN_MS = 2 * 60 * 60_000;
const initializedDatabases = new WeakSet<DatabaseSync>();
const locallyOwnedReceipts = new Set<string>();
type CronRunReceiptFinish = {
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
  env?: NodeJS.ProcessEnv;
};
type CronRunReceiptSettlement = {
  finish?: CronRunReceiptFinish;
  releaseRequested: boolean;
  onFinishError: (error: unknown) => void;
};
const pendingReceiptSettlements = new Map<string, CronRunReceiptSettlement>();
type CronRunReceiptFinishRetry = { finish: CronRunReceiptFinish; timer: NodeJS.Timeout | null };
const pendingReceiptFinishRetries = new Map<string, CronRunReceiptFinishRetry>();

export class CronRunReceiptConflictError extends Error {
  readonly candidate: CronRunReceiptRecoveryCandidate;

  constructor(readonly receipt: CronRunReceipt) {
    super(`cron job ${receipt.jobId} is already running in process ${receipt.ownerPid}`);
    this.name = "CronRunReceiptConflictError";
    this.candidate = receiptHandle(receipt);
  }
}

export class CronRunReceiptRevisionError extends Error {
  constructor(
    readonly receiptId: string,
    message = "cron run configuration changed",
    readonly reason: "revision-changed" | "owner-unavailable" = "revision-changed",
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
  // sqlite-allow-raw -- Canonical feature-local additive DDL only.
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarker + CRON_RUN_RECEIPT_SCHEMA_END.length),
  );
}

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(database);
}

function activeRow(db: DatabaseSync, key: string): Array<Pick<CronRunReceiptRow, "job_id">>;
function activeRow(db: DatabaseSync, key: string, jobId: string): CronRunReceiptRow | undefined;
function activeRow(db: DatabaseSync, key: string, jobId?: string) {
  const find = () => {
    const active = query(db)
      .selectFrom("cron_run_receipts")
      .where("store_key", "=", key)
      .where("status", "=", "running");
    return jobId === undefined
      ? executeSqliteQuerySync(db, active.select("job_id")).rows
      : executeSqliteQueryTakeFirstSync(db, active.selectAll().where("job_id", "=", jobId));
  };
  try {
    return find();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "no such table: cron_run_receipts") {
      throw error;
    }
    // A direct transaction can be the first receipt user after upgrade.
    ensureCronRunReceiptSchema(db);
    return find();
  }
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

/** Binds the exact admitted execution to its authoritative receipt without changing lifecycle. */
export function bindCronRunReceiptExecution(params: {
  admitted: AdmittedRunContext;
  handle: CronRunReceiptHandle;
  options?: OpenClawStateDatabaseOptions;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  return withReceiptWrite(
    "cron.run-receipt.execution-binding",
    params.options ?? {},
    (database) => {
      try {
        assertCronRunReceiptOwnedInDatabase({ database, handle: params.handle });
      } catch (error) {
        if (!(error instanceof CronRunReceiptRevisionError)) {
          throw error;
        }
        return "missing";
      }
      return bindExecutionOwnerLifecycleMetadata({
        db: database,
        ownerKind: "cron",
        ownerId: params.handle.receiptId,
        binding,
      });
    },
  );
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

function currentJob(database: DatabaseSync, storeKey: string, jobId: string): CronJob | undefined {
  const rows = loadCronRows(database, storeKey, new Set([jobId]));
  return loadedCronStoreFromRows(rows).store.jobs[0];
}

function sameOwner(left: CronRunReceiptRow, right: CronRunReceiptOwnerObservation): boolean {
  return (
    left.receipt_id === right.receiptId &&
    left.owner_pid === right.ownerPid &&
    left.owner_start_time === right.ownerStartTime &&
    left.started_at_ms === right.startedAtMs
  );
}

function observeOwner(row: CronRunReceiptRow): CronRunReceiptOwnerObservation {
  return {
    receiptId: row.receipt_id,
    ownerPid: row.owner_pid,
    ownerStartTime: row.owner_start_time,
    startedAtMs: row.started_at_ms,
  };
}

function ownerStale(owner: CronRunReceiptOwnerObservation, nowMs = Date.now()): boolean {
  if (owner.ownerPid === process.pid) {
    return !locallyOwnedReceipts.has(owner.receiptId);
  }
  if (isPidDefinitelyDead(owner.ownerPid)) {
    return true;
  }
  const observedStartTime = getFileLockProcessStartTime(owner.ownerPid);
  if (owner.ownerStartTime !== null && observedStartTime !== null) {
    return owner.ownerStartTime !== observedStartTime;
  }
  // An unverifiable foreign PID cannot fence a job forever. Revoke only after
  // the stuck-run horizon; verified owners and locally held work never age out.
  return nowMs - owner.startedAtMs > CRON_STUCK_RUN_MS;
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

function pruneTerminalReceipts(database: DatabaseSync, storeKey: string, jobId: string): void {
  const terminalIds = executeSqliteQuerySync(
    database,
    query(database)
      .selectFrom("cron_run_receipts")
      .select("receipt_id")
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId)
      .where("status", "!=", "running")
      .orderBy("finished_at_ms", "desc")
      .orderBy("started_at_ms", "desc")
      .orderBy("receipt_id", "desc"),
  ).rows.slice(CRON_RUN_RECEIPT_TERMINAL_RETENTION);
  for (let index = 0; index < terminalIds.length; index += CRON_RUN_RECEIPT_DELETE_BATCH_SIZE) {
    const receiptIds = terminalIds
      .slice(index, index + CRON_RUN_RECEIPT_DELETE_BATCH_SIZE)
      .map((row) => row.receipt_id);
    deleteExecutionOwnerLifecycleMetadata({
      db: database,
      ownerKind: "cron",
      ownerIds: receiptIds,
    });
    executeSqliteQuerySync(
      database,
      query(database)
        .deleteFrom("cron_run_receipts")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId)
        .where("status", "!=", "running")
        .where("receipt_id", "in", receiptIds),
    );
  }
}

/** Prepares process liveness facts before the caller enters its commit transaction. */
export function prepareCronRunReceiptAdjudication(params: {
  storePath: string;
  jobId: string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): PreparedCronRunReceiptAdjudication {
  const storeKey = cronStoreKey(params.storePath);
  const options = params.env ? { env: params.env } : {};
  const observed = withReceiptWrite("cron.run-receipt.inspect", options, (database) =>
    activeRow(database, storeKey, params.jobId),
  );
  return {
    storeKey,
    ...(observed ? { observed: observeOwner(observed) } : {}),
    observedStale: observed ? ownerStale(observeOwner(observed), params.nowMs) : false,
  };
}

export function prepareCronRunReceiptClaim(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
  env?: NodeJS.ProcessEnv;
}): PreparedCronRunReceiptClaim {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  if (ownerStartTime === null) {
    throw new Error("cron run cannot acquire a durable fence without process start identity");
  }
  const adjudication = prepareCronRunReceiptAdjudication({
    storePath: params.storePath,
    jobId: params.job.id,
    nowMs: params.startedAtMs,
    env: params.env,
  });
  const storeKey = cronStoreKey(params.storePath);
  const handle: CronRunReceiptHandle = {
    receiptId: crypto.randomUUID(),
    storeKey,
    jobId: params.job.id,
    configRevision: resolveCronJobConfigRevision(params.job),
    agentId: params.agentId,
    ownerPid: process.pid,
    ownerStartTime,
    startedAtMs: params.startedAtMs,
  };
  return {
    handle,
    ...adjudication,
    ...(params.requestRunId ? { requestRunId: params.requestRunId } : {}),
  };
}

/** Rechecks the owner and phase start so activation invalidates an age-based stale decision. */
export function adjudicateActiveCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  jobId: string;
  prepared: PreparedCronRunReceiptAdjudication;
  finishedAtMs: number;
}): void {
  const current = activeRow(params.database, params.prepared.storeKey, params.jobId);
  if (!current) {
    return;
  }
  if (
    params.prepared.observed &&
    params.prepared.observedStale &&
    sameOwner(current, params.prepared.observed)
  ) {
    executeSqliteQuerySync(
      params.database,
      query(params.database)
        .updateTable("cron_run_receipts")
        .set({
          status: "interrupted",
          finished_at_ms: params.finishedAtMs,
          error_text: "cron: job interrupted because owner is unavailable",
        })
        .where("receipt_id", "=", current.receipt_id)
        .where("status", "=", "running"),
    );
    return;
  }
  throw new CronRunReceiptConflictError(receiptFromRow(current));
}

/** Claims the receipt inside the caller's synchronous cron-state transaction. */
export function claimCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  prepared: PreparedCronRunReceiptClaim;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  const { handle } = params.prepared;
  if (handle.ownerStartTime === null) {
    throw new Error("cron run cannot acquire a durable fence without process start identity");
  }
  adjudicateActiveCronRunReceiptInDatabase({
    database: params.database,
    jobId: handle.jobId,
    prepared: params.prepared,
    finishedAtMs: handle.startedAtMs,
  });
  pruneTerminalReceipts(params.database, handle.storeKey, handle.jobId);
  validateCurrentJob({
    database: params.database,
    handle,
    resolveAgentId: params.resolveAgentId,
  });
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .insertInto("cron_run_receipts")
      .values({
        receipt_id: handle.receiptId,
        store_key: handle.storeKey,
        job_id: handle.jobId,
        config_revision: handle.configRevision,
        agent_id: handle.agentId,
        request_run_id: params.prepared.requestRunId ?? null,
        status: "running",
        owner_pid: handle.ownerPid,
        owner_start_time: handle.ownerStartTime,
        started_at_ms: handle.startedAtMs,
        finished_at_ms: null,
        error_text: null,
      }),
  );
  const claimed = receiptHandle(
    receiptFromRow(activeRow(params.database, handle.storeKey, handle.jobId)!),
  );
  locallyOwnedReceipts.add(claimed.receiptId);
  return claimed;
}

export function findActiveCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  storePath: string;
  jobId: string;
}): CronRunReceiptRecoveryCandidate | undefined {
  const row = activeRow(params.database, cronStoreKey(params.storePath), params.jobId);
  return row ? receiptHandle(receiptFromRow(row)) : undefined;
}

export function listActiveCronRunReceiptJobIdsInDatabase(
  database: DatabaseSync,
  storePath: string,
) {
  return new Set(activeRow(database, cronStoreKey(storePath)).map((row) => row.job_id));
}

export function inspectActiveCronRunReceipt(params: {
  storePath: string;
  jobId: string;
  env?: NodeJS.ProcessEnv;
}): CronRunReceiptRecoveryCandidate | undefined {
  return withReceiptWrite(
    "cron.run-receipt.recovery-inspect",
    params.env ? { env: params.env } : {},
    (database) =>
      findActiveCronRunReceiptInDatabase({
        database,
        storePath: params.storePath,
        jobId: params.jobId,
      }),
  );
}

export function isCronRunReceiptOwnerStale(
  candidate: CronRunReceiptRecoveryCandidate,
  nowMs = Date.now(),
): boolean {
  return ownerStale(candidate, nowMs);
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptOwnedInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
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
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptCurrentInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
}): void {
  assertCronRunReceiptOwnedInDatabase(params);
  validateCurrentJob({
    database: params.database,
    handle: params.handle,
    resolveAgentId: params.resolveAgentId,
  });
}

/** Advances a queued lease to its execution start inside the marker transaction. */
export function activateCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  startedAtMs: number;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  assertCronRunReceiptCurrentInDatabase(params);
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({ started_at_ms: params.startedAtMs })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running"),
  );
  return { ...params.handle, startedAtMs: params.startedAtMs };
}

export function assertCronRunReceiptCurrent(params: {
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
  isAgentAvailable?: (agentId: string) => boolean;
  allowMissingJob?: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  if (params.isAgentAvailable && !params.isAgentAvailable(params.handle.agentId)) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      `cron job agent is unavailable: ${params.handle.agentId}`,
      "owner-unavailable",
    );
  }
  withReceiptWrite(
    "cron.run-receipt.assert-current",
    params.env ? { env: params.env } : {},
    (database) =>
      params.allowMissingJob
        ? assertCronRunReceiptOwnedInDatabase({ database, handle: params.handle })
        : assertCronRunReceiptCurrentInDatabase({ database, ...params }),
  );
}

/** Keeps the durable lease live when timeout/cancel returns before the runner. */
export function trackCronRunReceiptSettlement(params: {
  handle: CronRunReceiptHandle;
  settlement: Promise<unknown>;
  onFinishError: (error: unknown) => void;
}): void {
  const receiptId = params.handle.receiptId;
  const pending: CronRunReceiptSettlement = {
    releaseRequested: false,
    onFinishError: params.onFinishError,
  };
  pendingReceiptSettlements.set(receiptId, pending);
  const settle = () => {
    if (pendingReceiptSettlements.get(receiptId) !== pending) {
      return;
    }
    pendingReceiptSettlements.delete(receiptId);
    if (pending.finish) {
      try {
        finishCronRunReceipt(pending.finish);
      } catch (error) {
        pending.onFinishError(error);
      }
    } else if (pending.releaseRequested) {
      locallyOwnedReceipts.delete(receiptId);
    }
  };
  void params.settlement.then(settle, settle);
}

export function isCronRunReceiptSettlementPending(handle: CronRunReceiptHandle): boolean {
  return pendingReceiptSettlements.has(handle.receiptId);
}

function clearCronRunReceiptFinishRetry(receiptId: string): void {
  const pending = pendingReceiptFinishRetries.get(receiptId);
  if (pending?.timer) {
    clearTimeout(pending.timer);
  }
  pendingReceiptFinishRetries.delete(receiptId);
}

function queueCronRunReceiptFinishRetry(finish: CronRunReceiptFinish): void {
  const receiptId = finish.handle.receiptId;
  let pending = pendingReceiptFinishRetries.get(receiptId);
  if (!pending) {
    pending = { finish, timer: null };
    pendingReceiptFinishRetries.set(receiptId, pending);
  }
  if (pending.timer) {
    return;
  }
  // Keep local ownership until a retry commits. Foreign recovery requires
  // owner exit, PID reuse, or expiry of an unverifiable process identity.
  pending.timer = setTimeout(() => {
    pending!.timer = null;
    try {
      finishCronRunReceipt(pending!.finish);
    } catch {
      // finishCronRunReceipt retained the handle and scheduled the next retry.
    }
  }, CRON_RUN_RECEIPT_FINISH_RETRY_MS);
  pending.timer.unref?.();
}

export function finishCronRunReceipt(params: CronRunReceiptFinish): CronRunReceipt | undefined {
  const pending = pendingReceiptSettlements.get(params.handle.receiptId);
  if (pending) {
    pending.finish ??= params;
    return undefined;
  }
  try {
    const result = withReceiptWrite(
      "cron.run-receipt.finish",
      params.env ? { env: params.env } : {},
      (database) => finishCronRunReceiptInDatabase({ database, ...params }),
    );
    clearCronRunReceiptFinishRetry(params.handle.receiptId);
    locallyOwnedReceipts.delete(params.handle.receiptId);
    return result;
  } catch (error) {
    queueCronRunReceiptFinishRetry(params);
    throw error;
  }
}

/** Releases only this process's liveness proof after terminal persistence fails. */
export function releaseLocalCronRunReceiptOwnership(handle: CronRunReceiptHandle): void {
  const pending = pendingReceiptSettlements.get(handle.receiptId);
  if (pending) {
    pending.releaseRequested = true;
    return;
  }
  if (pendingReceiptFinishRetries.has(handle.receiptId)) {
    return;
  }
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
  pruneTerminalReceipts(params.database, params.handle.storeKey, params.handle.jobId);
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    query(params.database)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("receipt_id", "=", params.handle.receiptId),
  );
  return row ? receiptFromRow(row) : undefined;
}
