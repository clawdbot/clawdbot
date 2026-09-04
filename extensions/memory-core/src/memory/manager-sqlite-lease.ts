// Memory Core owns crash-safe SQLite coordination leases shared across processes.
import type { DatabaseSync } from "node:sqlite";
import { extractErrorCode, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

export type MemorySqliteLeaseHandle = {
  release: () => void;
};

function isSqliteBusyError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked/iu.test(message);
}

function openMemoryLeaseDatabase(location: string): DatabaseSync {
  const database = openNodeSqliteDatabase(location);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}

function createMemorySqliteLeaseHandle(
  database: DatabaseSync,
  transactionActive: boolean,
): MemorySqliteLeaseHandle {
  return {
    release: () => {
      let releaseError: unknown;
      if (transactionActive) {
        try {
          database.exec("ROLLBACK");
        } catch (err) {
          releaseError = err;
        }
      }
      try {
        database.close();
      } catch (err) {
        releaseError ??= err;
      }
      if (releaseError) {
        throw toErrorObject(releaseError, "Failed to release memory SQLite lease");
      }
    },
  };
}

export function tryAcquireMemorySqliteLease(
  location: string,
  mode: "shared" | "exclusive",
): MemorySqliteLeaseHandle | undefined {
  const database = openMemoryLeaseDatabase(location);
  try {
    if (mode === "exclusive") {
      database.exec("BEGIN EXCLUSIVE");
    } else {
      database.exec("BEGIN");
      // BEGIN is deferred. Reading sqlite_schema acquires the shared lock without
      // requiring a coordination table or touching the live memory database.
      database.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    }
  } catch (err) {
    database.close();
    if (isSqliteBusyError(err)) {
      return undefined;
    }
    throw err;
  }
  return createMemorySqliteLeaseHandle(database, true);
}
