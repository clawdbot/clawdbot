// Provides SQLite transaction helpers with nested savepoints.
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
// The cache-state module keeps this lifecycle edge off the kysely value graph
// so cold control-plane paths using transactions do not load kysely.
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { shouldReportSqliteLockFailure } from "./sqlite-busy-timeout.js";
import { isSqliteLockError, readSqliteErrorDetails } from "./sqlite-error-classification.js";

export { isSqliteCorruptionError, isSqliteLockError } from "./sqlite-error-classification.js";

const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;
const DEFAULT_SLOW_TRANSACTION_HOLD_MS = 1_000;

const transactionLog = createSubsystemLogger("sqlite/transaction");

export type SqliteTransactionOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
  logger?: Pick<SubsystemLogger, "warn">;
  operationLabel?: string;
  slowTransactionHoldMs?: number;
};

type SqliteTransactionStep = "begin" | "commit";
type SqliteTransactionMode = "deferred" | "immediate";

function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

function slowBusyWaitThresholdMs(options: SqliteTransactionOptions | undefined): number {
  if (options?.busyTimeoutMs === undefined || options.busyTimeoutMs <= 0) {
    return DEFAULT_SLOW_BUSY_WAIT_MS;
  }
  return Math.min(DEFAULT_SLOW_BUSY_WAIT_MS, options.busyTimeoutMs);
}

function slowTransactionHoldThresholdMs(options: SqliteTransactionOptions | undefined): number {
  return options?.slowTransactionHoldMs ?? DEFAULT_SLOW_TRANSACTION_HOLD_MS;
}

function transactionLogger(
  options: SqliteTransactionOptions | undefined,
): Pick<SubsystemLogger, "warn"> {
  return options?.logger ?? transactionLog;
}

function logSlowTransactionHold(params: {
  elapsedMs: number;
  options?: SqliteTransactionOptions;
}): void {
  if (params.elapsedMs < slowTransactionHoldThresholdMs(params.options)) {
    return;
  }
  transactionLogger(params.options).warn("slow SQLite transaction hold", {
    async: false,
    ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
    elapsedMs: params.elapsedMs,
    ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
    pid: process.pid,
    thresholdMs: slowTransactionHoldThresholdMs(params.options),
  });
}

function logSlowTransactionStep(params: {
  elapsedMs: number;
  options?: SqliteTransactionOptions;
  step: SqliteTransactionStep;
}): void {
  if (params.elapsedMs < slowBusyWaitThresholdMs(params.options)) {
    return;
  }
  transactionLogger(params.options).warn("slow SQLite transaction lock wait", {
    async: false,
    ...(params.options?.busyTimeoutMs !== undefined
      ? { busyTimeoutMs: params.options.busyTimeoutMs }
      : {}),
    ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
    elapsedMs: params.elapsedMs,
    ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
    pid: process.pid,
    step: params.step,
  });
}

function execTimedTransactionStep(params: {
  db: DatabaseSync;
  options?: SqliteTransactionOptions;
  sql: string;
  step: SqliteTransactionStep;
}): number {
  const startedAt = Date.now();
  try {
    params.db.exec(params.sql);
    const elapsedMs = Date.now() - startedAt;
    logSlowTransactionStep({
      elapsedMs,
      options: params.options,
      step: params.step,
    });
    return elapsedMs;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (isSqliteLockError(error) && shouldReportSqliteLockFailure(params.db)) {
      const sqliteDetails = readSqliteErrorDetails(error);
      transactionLogger(params.options).warn("SQLite transaction lock wait failed", {
        async: false,
        ...(params.options?.busyTimeoutMs !== undefined
          ? { busyTimeoutMs: params.options.busyTimeoutMs }
          : {}),
        ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
        code: sqliteDetails.code,
        elapsedMs,
        failureKind: "lock-contention",
        ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
        pid: process.pid,
        ...(sqliteDetails.extendedCode !== undefined
          ? { sqliteErrcode: sqliteDetails.extendedCode }
          : {}),
        ...(sqliteDetails.primaryCode !== undefined
          ? { sqlitePrimaryCode: sqliteDetails.primaryCode }
          : {}),
        step: params.step,
      });
    }
    throw error;
  }
}

function beginTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
  mode: SqliteTransactionMode,
): void {
  execTimedTransactionStep({
    db,
    options,
    sql: mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN",
    step: "begin",
  });
}

function commitImmediateTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
): void {
  execTimedTransactionStep({
    db,
    options,
    sql: "COMMIT",
    step: "commit",
  });
}

function abortImmediateTransaction(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // If rollback itself fails, close the handle so callers cannot keep using a
    // connection that may still hold an abandoned write transaction.
    try {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    } catch {
      // Preserve the original transaction error; close failure is secondary.
    }
  }
}

function runSqliteTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  mode: SqliteTransactionMode,
  options?: SqliteTransactionOptions,
): T {
  if (db.isTransaction) {
    // SQLite targets the most recent matching savepoint. Reusing its name keeps
    // nested native/SDK calls correct without module-local depth or counters.
    db.exec("SAVEPOINT openclaw_tx_nested");
    try {
      const result = operation();
      assertSyncTransactionResult(result);
      db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK TO SAVEPOINT openclaw_tx_nested");
      } finally {
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      }
      throw error;
    }
  }

  beginTransaction(db, options, mode);
  const transactionStartedAt = Date.now();
  try {
    const result = operation();
    assertSyncTransactionResult(result);
    logSlowTransactionHold({
      elapsedMs: Date.now() - transactionStartedAt,
      options,
    });
    commitImmediateTransaction(db, options);
    return result;
  } catch (error) {
    abortImmediateTransaction(db);
    throw error;
  }
}

/** Run synchronous reads against one deferred SQLite snapshot. */
export function runSqliteDeferredTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "deferred", options);
}

export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "immediate", options);
}
