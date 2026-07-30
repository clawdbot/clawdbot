// Memory Core plugin module serializes full memory reindex builds across processes.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

export type MemoryReindexLockHandle = {
  release: () => void;
};

function resolveMemoryReindexLockPath(dbPath: string): string {
  return `${dbPath}.reindex-lock.sqlite`;
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message);
}

function openMemoryLockDatabase(lockPath: string): DatabaseSync {
  const lockDb = openNodeSqliteDatabase(lockPath);
  try {
    lockDb.exec("PRAGMA busy_timeout = 0");
    return lockDb;
  } catch (err) {
    try {
      lockDb.close();
    } catch {}
    throw err;
  }
}

function createMemoryReindexLockHandle(lockDb: DatabaseSync): MemoryReindexLockHandle {
  return {
    release: () => {
      let releaseError: unknown;
      try {
        lockDb.exec("ROLLBACK");
      } catch (err) {
        releaseError = err;
      }
      try {
        lockDb.close();
      } catch (err) {
        releaseError ??= err;
      }
      if (releaseError) {
        throw new Error("Failed to release memory reindex lock", { cause: releaseError });
      }
    },
  };
}

/** Try to acquire the build lock without locking readers of the live agent database. */
export function tryAcquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle | undefined {
  const lockDb = openMemoryLockDatabase(resolveMemoryReindexLockPath(dbPath));
  try {
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lockDb.close();
    if (isSqliteBusyError(err)) {
      return undefined;
    }
    throw err;
  }
  return createMemoryReindexLockHandle(lockDb);
}

/** Acquire an exclusive build lock without locking readers of the live agent database. */
export function acquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle {
  const lock = tryAcquireMemoryReindexLock(dbPath);
  if (lock) {
    return lock;
  }
  throw Object.assign(
    new Error(
      `Memory reindex lock is held at ${resolveMemoryReindexLockPath(dbPath)}; another reindex is active.`,
    ),
    { code: "SQLITE_BUSY" },
  );
}
