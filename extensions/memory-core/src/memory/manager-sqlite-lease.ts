// Memory Core owns crash-safe SQLite coordination leases shared across processes.
import type { DatabaseSync } from "node:sqlite";
import { extractErrorCode, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

export type MemorySqliteLeaseHandle = {
  release: () => void;
};

const MEMORY_SQLITE_LEASE_RETRY_DELAY_MS = 25;

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

/** Acquire writer admission without dropping PENDING intent after the first reader collision. */
export async function acquireMemorySqliteWriterLease(
  location: string,
  signal?: AbortSignal,
): Promise<MemorySqliteLeaseHandle> {
  while (true) {
    signal?.throwIfAborted();
    const database = openMemoryLeaseDatabase(location);
    try {
      database.exec("PRAGMA locking_mode = EXCLUSIVE");
      database.exec("BEGIN IMMEDIATE");
      // Rewriting the unchanged header field creates a schema-free write transaction.
      // A blocked commit retains SQLite's PENDING lock so later readers cannot overtake it.
      database.exec("PRAGMA user_version = 0");
    } catch (err) {
      database.close();
      if (!isSqliteBusyError(err)) {
        throw err;
      }
      await sleepWithAbort(MEMORY_SQLITE_LEASE_RETRY_DELAY_MS, signal);
      continue;
    }

    while (true) {
      try {
        database.exec("COMMIT");
        return createMemorySqliteLeaseHandle(database, false);
      } catch (err) {
        if (!isSqliteBusyError(err)) {
          createMemorySqliteLeaseHandle(database, true).release();
          throw err;
        }
        try {
          await sleepWithAbort(MEMORY_SQLITE_LEASE_RETRY_DELAY_MS, signal);
        } catch (sleepError) {
          createMemorySqliteLeaseHandle(database, true).release();
          throw sleepError;
        }
      }
    }
  }
}
