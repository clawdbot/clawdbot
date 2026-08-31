// Memory Core plugin module serializes full memory reindex builds across processes.
import {
  tryAcquireMemorySqliteLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";

export type MemoryReindexLockHandle = MemorySqliteLeaseHandle;

const REINDEX_LOCK_WAIT_TIMEOUT_MS = 2_000;
const REINDEX_LOCK_RETRY_DELAY_MS = 25;

function resolveMemoryReindexLockPath(dbPath: string): string {
  return `${dbPath}.reindex-lock.sqlite`;
}

async function sleepAsync(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createMemoryReindexBusyError(lockPath: string): Error & { code: string } {
  return Object.assign(
    new Error(`Memory reindex lock is held at ${lockPath}; another reindex is active.`),
    { code: "SQLITE_BUSY" },
  );
}

/** Try to acquire the build lock without locking readers of the live agent database. */
export function tryAcquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle | undefined {
  return tryAcquireMemorySqliteLease(resolveMemoryReindexLockPath(dbPath), "exclusive");
}

/** Wait asynchronously for the exclusive build lock without blocking the Node event loop. */
export async function waitForMemoryReindexLock(dbPath: string): Promise<MemoryReindexLockHandle> {
  const lockPath = resolveMemoryReindexLockPath(dbPath);
  const deadline = Date.now() + REINDEX_LOCK_WAIT_TIMEOUT_MS;
  do {
    const lock = tryAcquireMemoryReindexLock(dbPath);
    if (lock) {
      return lock;
    }
    await sleepAsync(REINDEX_LOCK_RETRY_DELAY_MS);
  } while (Date.now() < deadline);

  const finalLock = tryAcquireMemoryReindexLock(dbPath);
  if (finalLock) {
    return finalLock;
  }
  throw createMemoryReindexBusyError(lockPath);
}
