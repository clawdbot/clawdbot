// Provides SQLite transaction helpers with nested savepoints.
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

const transactionDepthByDatabase = new WeakMap<DatabaseSync, number>();

const SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
// Node reports SQLite failures with a generic string code and the extended
// SQLite result in `errcode`; the low byte identifies BUSY or LOCKED.
const SQLITE_BUSY_RESULT_CODE = 5;
const SQLITE_LOCKED_RESULT_CODE = 6;
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;
const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;
const DEFAULT_SLOW_TRANSACTION_HOLD_MS = 1_000;

let nextSavepointId = 0;
const transactionLog = createSubsystemLogger("sqlite/transaction");

export type SqliteTransactionOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
  logger?: Pick<SubsystemLogger, "warn">;
  operationLabel?: string;
  slowTransactionHoldMs?: number;
};

type SqliteTransactionStep = "begin" | "commit";

function nextSavepointName(): string {
  nextSavepointId += 1;
  return `openclaw_tx_${nextSavepointId}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

function sqliteErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function sqliteExtendedResultCode(error: unknown): number | undefined {
  const errcode =
    error && typeof error === "object" ? (error as { errcode?: unknown }).errcode : undefined;
  return typeof errcode === "number" && Number.isInteger(errcode) ? errcode : undefined;
}

function sqlitePrimaryResultCode(error: unknown): number | undefined {
  const errcode = sqliteExtendedResultCode(error);
  return errcode === undefined ? undefined : errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
}

function isTransactionLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code !== undefined && SQLITE_LOCK_ERROR_CODES.has(code)) {
    return true;
  }
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_BUSY_RESULT_CODE || primaryCode === SQLITE_LOCKED_RESULT_CODE;
}

function slowBusyWaitThresholdMs(options: SqliteTransactionOptions | undefined): number {
  if (options?.busyTimeoutMs === undefined) {
    return DEFAULT_SLOW_BUSY_WAIT_MS;
  }
  return Math.min(DEFAULT_SLOW_BUSY_WAIT_MS, Math.max(1, options.busyTimeoutMs));
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
    if (isTransactionLockError(error)) {
      const sqliteErrcode = sqliteExtendedResultCode(error);
      const sqlitePrimaryCode = sqlitePrimaryResultCode(error);
      transactionLogger(params.options).warn("SQLite transaction lock wait failed", {
        async: false,
        ...(params.options?.busyTimeoutMs !== undefined
          ? { busyTimeoutMs: params.options.busyTimeoutMs }
          : {}),
        ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
        code: sqliteErrorCode(error),
        elapsedMs,
        failureKind: "lock-contention",
        ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
        pid: process.pid,
        ...(sqliteErrcode !== undefined ? { sqliteErrcode } : {}),
        ...(sqlitePrimaryCode !== undefined ? { sqlitePrimaryCode } : {}),
        step: params.step,
      });
    }
    throw error;
  }
}

function beginImmediateTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
): void {
  execTimedTransactionStep({
    db,
    options,
    sql: "BEGIN IMMEDIATE",
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
      db.close();
    } catch {
      // Preserve the original transaction error; close failure is secondary.
    }
  }
}

function getTransactionDepth(db: DatabaseSync): number {
  return transactionDepthByDatabase.get(db) ?? 0;
}

function setTransactionDepth(db: DatabaseSync, depth: number): void {
  if (depth <= 0) {
    transactionDepthByDatabase.delete(db);
    return;
  }
  transactionDepthByDatabase.set(db, depth);
}

export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  const depth = getTransactionDepth(db);
  if (depth > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    setTransactionDepth(db, depth + 1);
    try {
      const result = operation();
      assertSyncTransactionResult(result);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } finally {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw error;
    } finally {
      setTransactionDepth(db, depth);
    }
  }

  beginImmediateTransaction(db, options);
  setTransactionDepth(db, 1);
  let transactionStillActive = true;
  let result: T;
  const transactionStartedAt = Date.now();
  try {
    result = operation();
    assertSyncTransactionResult(result);
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }

  try {
    logSlowTransactionHold({
      elapsedMs: Date.now() - transactionStartedAt,
      options,
    });
    commitImmediateTransaction(db, options);
    transactionStillActive = false;
    return result;
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }
}
