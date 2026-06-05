// File lock helpers serialize plugin writes that share a filesystem-backed state file.
import "../infra/fs-safe-defaults.js";
import {
  acquireFileLock as acquireFsSafeFileLock,
  drainFileLockManagerForTest,
  resetFileLockManagerForTest,
} from "@openclaw/fs-safe/file-lock";
import { shouldRemoveDeadOwnerOrExpiredLock } from "../infra/stale-lock-file.js";
import { getProcessStartTime } from "../shared/pid-alive.js";

/** Retry and stale-recovery policy for acquiring a filesystem lock. */
export type FileLockOptions = {
  /** Retry policy used while waiting for another process or re-entrant holder to release. */
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  /** Milliseconds after which a dead-owner or expired sidecar lock may be reclaimed. */
  stale: number;
};

/** Live file-lock handle returned after successful acquisition. */
export type FileLockHandle = {
  /** Absolute path to the `.lock` sidecar held for this file path. */
  lockPath: string;
  /** Releases one held reference; callers must await it before assuming peers can proceed. */
  release: () => Promise<void>;
};

/** Stable error code used when lock acquisition retries are exhausted. */
export const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
/** Stable error code used when stale lock recovery cannot proceed safely. */
export const FILE_LOCK_STALE_ERROR_CODE = "file_lock_stale";

/** Typed error thrown when a lock cannot be acquired before timeout. */
export type FileLockTimeoutError = Error & {
  /** Stable error discriminator for lock acquisition timeout handling. */
  code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
  /** Lock sidecar path that could not be acquired before retries were exhausted. */
  lockPath: string;
};

/** Typed error thrown when a stale lock sidecar cannot be reclaimed safely. */
export type FileLockStaleError = Error & {
  /** Stable error discriminator for stale-lock reclaim failures. */
  code: typeof FILE_LOCK_STALE_ERROR_CODE;
  /** Lock sidecar path that could not be safely reclaimed. */
  lockPath: string;
};

const FILE_LOCK_MANAGER_KEY = "openclaw.plugin-sdk.file-lock";

async function shouldReclaimPluginLock(params: {
  lockPath: string;
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs: number;
}): Promise<boolean> {
  return shouldRemoveDeadOwnerOrExpiredLock({
    payload: params.payload,
    staleMs: params.staleMs,
    nowMs: params.nowMs,
  });
}

function normalizeLockError(err: unknown): never {
  if ((err as { code?: unknown }).code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
    throw Object.assign(new Error((err as Error).message), {
      code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      lockPath: (err as { lockPath?: string }).lockPath ?? "",
    }) as FileLockTimeoutError;
  }
  if ((err as { code?: unknown }).code === FILE_LOCK_STALE_ERROR_CODE) {
    throw Object.assign(new Error((err as Error).message), {
      code: FILE_LOCK_STALE_ERROR_CODE,
      lockPath: (err as { lockPath?: string }).lockPath ?? "",
    }) as FileLockStaleError;
  }
  throw err;
}

/** Reset process-local file-lock state for tests that isolate lock managers. */
export function resetFileLockStateForTest(): void {
  resetFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}

/** Wait for process-local file-lock state to drain before test teardown. */
export async function drainFileLockStateForTest(): Promise<void> {
  await drainFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}

/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<FileLockHandle> {
  try {
    const lock = await acquireFsSafeFileLock(filePath, {
      managerKey: FILE_LOCK_MANAGER_KEY,
      staleMs: options.stale,
      retry: options.retries,
      staleRecovery: "remove-if-unchanged",
      allowReentrant: true,
      payload: () => {
        const payload: Record<string, unknown> = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        const starttime = getProcessStartTime(process.pid);
        if (starttime !== null) {
          payload.starttime = starttime;
        }
        return payload;
      },
      shouldReclaim: shouldReclaimPluginLock,
      shouldRemoveStaleLock: (snapshot) =>
        shouldRemoveDeadOwnerOrExpiredLock({
          payload: snapshot.payload,
          staleMs: options.stale,
        }),
    });
    return { lockPath: lock.lockPath, release: lock.release };
  } catch (err) {
    return normalizeLockError(err);
  }
}

/** Run an async callback while holding a file lock, always releasing the lock afterward. */
export async function withFileLock<T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
