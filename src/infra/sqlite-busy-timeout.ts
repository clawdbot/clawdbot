import type { DatabaseSync } from "node:sqlite";

export type SqliteLockFailureReporting = "report" | "suppress";

const lockFailureReportingByDatabase = new WeakMap<DatabaseSync, SqliteLockFailureReporting>();

export function normalizeSqliteNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function readSqliteBusyTimeout(database: DatabaseSync): number {
  const row = database // sqlite-allow-raw -- Connection-local policy must be restored after the bounded operation.
    .prepare("PRAGMA busy_timeout")
    .get();
  const value = row?.busy_timeout ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

export function setSqliteBusyTimeout(database: DatabaseSync, busyTimeoutMs: number): void {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  database.exec(`PRAGMA busy_timeout = ${normalizedTimeoutMs}`); // sqlite-allow-raw -- Connection-local lock policy.
}

export function shouldReportSqliteLockFailure(database: DatabaseSync): boolean {
  return lockFailureReportingByDatabase.get(database) !== "suppress";
}

/** Run one synchronous operation with a temporary connection-local busy timeout. */
export function runWithSqliteBusyTimeout<T>(
  database: DatabaseSync,
  busyTimeoutMs: number,
  operation: () => T,
  options: { lockFailureReporting?: SqliteLockFailureReporting } = {},
): T {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const previousBusyTimeoutMs = readSqliteBusyTimeout(database);
  const previousLockFailureReporting = lockFailureReportingByDatabase.get(database);
  if (options.lockFailureReporting) {
    lockFailureReportingByDatabase.set(database, options.lockFailureReporting);
  }
  if (previousBusyTimeoutMs !== normalizedTimeoutMs) {
    setSqliteBusyTimeout(database, normalizedTimeoutMs);
  }
  try {
    return operation();
  } finally {
    if (database.isOpen && previousBusyTimeoutMs !== normalizedTimeoutMs) {
      setSqliteBusyTimeout(database, previousBusyTimeoutMs);
    }
    if (previousLockFailureReporting) {
      lockFailureReportingByDatabase.set(database, previousLockFailureReporting);
    } else {
      lockFailureReportingByDatabase.delete(database);
    }
  }
}
