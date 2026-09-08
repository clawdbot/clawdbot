// Provides SQLite transaction helpers with nested savepoints.
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
// The cache-state module keeps this lifecycle edge off the kysely value graph
// so cold control-plane paths using transactions do not load kysely.
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import {
  readSqliteBusyTimeout,
  runWithSqliteBusyTimeout,
  shouldReportSqliteLockFailure,
} from "./sqlite-busy-timeout.js";
import { discardSqliteTransactionState } from "./sqlite-post-commit.js";

const SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
// Node reports SQLite failures with a generic string code and the extended
// SQLite result in `errcode`; the low byte identifies BUSY or LOCKED.
const SQLITE_BUSY_RESULT_CODE = 5;
const SQLITE_LOCKED_RESULT_CODE = 6;
const SQLITE_CORRUPT_RESULT_CODE = 11;
const SQLITE_NOTADB_RESULT_CODE = 26;
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;
const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;
const DEFAULT_SLOW_TRANSACTION_HOLD_MS = 1_000;

// The same native handle can cross transformed SDK module graphs. Retain the
// first terminal failure even when an inner caller catches it and continues.
const abortedTransactionSymbol = Symbol.for("openclaw.sqliteAbortedTransaction");
type TransactionDatabase = DatabaseSync & {
  [abortedTransactionSymbol]?: { error: unknown };
};

function assertTransactionUsable(db: TransactionDatabase): void {
  const aborted = db[abortedTransactionSymbol];
  if (aborted) {
    throw aborted.error;
  }
}

const transactionLog = createSubsystemLogger("sqlite/transaction");
const writeAdmissionServices = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWriteAdmissionServices"),
  () => new Map<string, Set<() => void>>(),
);

/** Keep worker-owned lock holders serviceable across connections and module graphs. */
export async function withSqliteWriteAdmissionService<T>(
  database: DatabaseSync,
  service: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const location = database.location();
  if (location === null) {
    throw new Error("SQLite write admission service requires a file-backed database");
  }
  const services = writeAdmissionServices.get(location) ?? new Set<() => void>();
  services.add(service);
  writeAdmissionServices.set(location, services);
  try {
    return await operation();
  } finally {
    services.delete(service);
    if (services.size === 0) {
      writeAdmissionServices.delete(location);
    }
  }
}

function beginImmediateTransaction(db: DatabaseSync): void {
  // Native location identifies reopened handles without probing the filesystem.
  const location = writeAdmissionServices.size > 0 ? db.location() : null;
  const services = location === null ? undefined : writeAdmissionServices.get(location);
  if (!services) {
    db.exec("BEGIN IMMEDIATE");
    return;
  }
  const deadline = performance.now() + readSqliteBusyTimeout(db);
  while (true) {
    try {
      runWithSqliteBusyTimeout(
        db,
        Math.min(25, Math.max(0, Math.ceil(deadline - performance.now()))),
        () => db.exec("BEGIN IMMEDIATE"),
      );
      return;
    } catch (error) {
      if (!isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      // Only admission repeats. Services retain their own authority and settlement
      // rules; caller mutations and postcommit publication have not started yet.
      for (const service of services) {
        service();
      }
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}

export type SqliteTransactionOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
  logger?: Pick<SubsystemLogger, "warn">;
  operationLabel?: string;
  slowTransactionHoldMs?: number;
  /** Enclose the physical commit in an owner's synchronous authority guard. */
  withCommit?: (commit: () => void) => void;
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

export function isSqliteLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code !== undefined && SQLITE_LOCK_ERROR_CODES.has(code)) {
    return true;
  }
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_BUSY_RESULT_CODE || primaryCode === SQLITE_LOCKED_RESULT_CODE;
}

/** Report proven file damage (corrupt page or non-database header), not transient failure. */
export function isSqliteCorruptionError(error: unknown): boolean {
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_CORRUPT_RESULT_CODE || primaryCode === SQLITE_NOTADB_RESULT_CODE;
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
    if (params.sql === "BEGIN IMMEDIATE") {
      beginImmediateTransaction(params.db);
    } else {
      params.db.exec(params.sql);
    }
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

function discardUnsafeConnection(db: TransactionDatabase, error: unknown): void {
  db[abortedTransactionSymbol] ??= { error };
  discardSqliteTransactionState(db);
  clearNodeSqliteKyselyCacheForDatabase(db);
  try {
    db.close();
  } catch {
    // Preserve the primary failure. The transaction helper also refuses reuse
    // if the handle was already closed or a lifecycle close hook failed.
  }
}

function abortImmediateTransaction(db: TransactionDatabase, error: unknown): void {
  if (db[abortedTransactionSymbol]) {
    return;
  }
  try {
    db.exec("ROLLBACK");
  } catch {
    // An abandoned transaction must not leak into later writes on this handle.
    discardUnsafeConnection(db, error);
  }
}

function runSqliteTransactionSync<T>(
  db: TransactionDatabase,
  operation: () => T,
  mode: SqliteTransactionMode,
  options?: SqliteTransactionOptions,
): T {
  assertTransactionUsable(db);
  if (db.isTransaction) {
    // SQLite targets the most recent matching savepoint. Reusing its name keeps
    // nested native/SDK calls correct without module-local depth or counters.
    db.exec("SAVEPOINT openclaw_tx_nested");
    try {
      const result = operation();
      assertSyncTransactionResult(result);
      assertTransactionUsable(db);
      db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      return result;
    } catch (error) {
      const failure = db[abortedTransactionSymbol];
      if (failure) {
        throw failure.error;
      }
      try {
        db.exec("ROLLBACK TO SAVEPOINT openclaw_tx_nested");
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      } catch {
        // SQLITE_FULL and RAISE(ROLLBACK) can remove the entire transaction,
        // including its savepoints. Never let a caught failure autocommit later.
        discardUnsafeConnection(db, error);
      }
      throw error;
    }
  }

  beginTransaction(db, options, mode);
  const transactionStartedAt = Date.now();
  try {
    const result = operation();
    assertSyncTransactionResult(result);
    assertTransactionUsable(db);
    logSlowTransactionHold({
      elapsedMs: Date.now() - transactionStartedAt,
      options,
    });
    if (options?.withCommit) {
      assertSyncTransactionResult(
        options.withCommit(() => commitImmediateTransaction(db, options)),
      );
    } else {
      commitImmediateTransaction(db, options);
    }
    return result;
  } catch (error) {
    abortImmediateTransaction(db, error);
    assertTransactionUsable(db);
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

/** Prepare outside the transaction; yield for admission without replaying admitted writes. */
export async function runSqliteImmediateTransaction<T>(
  db: DatabaseSync,
  prepare: () => Promise<(() => T) | undefined>,
  options?: SqliteTransactionOptions,
): Promise<T | undefined> {
  assertTransactionUsable(db);
  if (db.isTransaction) {
    throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
  }
  const deadline = performance.now() + readSqliteBusyTimeout(db);
  let entered = false;
  while (true) {
    const operation = await prepare();
    assertTransactionUsable(db);
    if (db.isTransaction) {
      throw new Error("SQLite preparation left a transaction open");
    }
    if (!operation) {
      return undefined;
    }
    try {
      return runWithSqliteBusyTimeout(
        db,
        0,
        (restore) =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              entered = true;
              restore();
              return operation();
            },
            options,
          ),
        { lockFailureReporting: "suppress" },
      );
    } catch (error) {
      if (entered || !isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      // The synchronous helper restored connection policy and left no transaction.
      await sleep(Math.min(25, Math.max(0, deadline - performance.now())));
      assertTransactionUsable(db);
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}
