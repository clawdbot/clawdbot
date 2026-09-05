// Memory Core plugin module serializes full memory reindex builds across processes.
import {
  tryAcquireMemorySqliteLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";

export type MemoryReindexLockHandle = MemorySqliteLeaseHandle;
export type MemoryReindexLockMode = "shared" | "exclusive";

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

/** Try to acquire the sync/reindex coordination lock without locking the live agent database. */
function tryAcquireMemoryReindexLock(
  dbPath: string,
  mode: MemoryReindexLockMode,
): MemoryReindexLockHandle | undefined {
  return tryAcquireMemorySqliteLease(resolveMemoryReindexLockPath(dbPath), mode);
}

/** Wait asynchronously for the sync/reindex lock without blocking the Node event loop. */
export async function waitForMemoryReindexLock(
  dbPath: string,
  mode: MemoryReindexLockMode = "exclusive",
): Promise<MemoryReindexLockHandle> {
  const lockPath = resolveMemoryReindexLockPath(dbPath);
  const deadline = Date.now() + REINDEX_LOCK_WAIT_TIMEOUT_MS;
  do {
    const lock = tryAcquireMemoryReindexLock(dbPath, mode);
    if (lock) {
      return lock;
    }
    await sleepAsync(REINDEX_LOCK_RETRY_DELAY_MS);
  } while (Date.now() < deadline);

  const finalLock = tryAcquireMemoryReindexLock(dbPath, mode);
  if (finalLock) {
    return finalLock;
  }
  throw createMemoryReindexBusyError(lockPath);
}

/** Run one operation under the requested coordination mode and always release its lease. */
export async function withMemoryReindexLock<T>(
  dbPath: string,
  mode: MemoryReindexLockMode,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await waitForMemoryReindexLock(dbPath, mode);
  try {
    return await run();
  } finally {
    lock.release();
  }
}
