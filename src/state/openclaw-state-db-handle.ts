// The handle lease outlives transactions and maintenance, including close-time WAL work.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { acquireStateDatabaseHandleLease } from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const handleLeases = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseHandleLeases"),
  () => new WeakMap<DatabaseSync, { release: () => void }>(),
);

export function openTrackedStateDatabase(pathname: string): DatabaseSync {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  try {
    const database = openNodeSqliteDatabase(pathname);
    handleLeases.set(database, lease);
    return database;
  } catch (error) {
    lease.release();
    throw error;
  }
}

export function closeTrackedStateDatabase(database: DatabaseSync): void {
  try {
    if (database.isOpen) {
      database.close();
    }
  } finally {
    // A failed close that leaves SQLite live cannot surrender file protection.
    if (!database.isOpen) {
      handleLeases.get(database)?.release();
      handleLeases.delete(database);
    }
  }
}
