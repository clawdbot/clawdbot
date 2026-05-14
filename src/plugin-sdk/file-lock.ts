import "../infra/fs-safe-defaults.js";
import {
  acquireFileLock as acquireFsSafeFileLock,
  drainFileLockManagerForTest,
  resetFileLockManagerForTest,
} from "@openclaw/fs-safe/file-lock";
import { shouldRemoveDeadOwnerOrExpiredLock } from "../infra/stale-lock-file.js";

export type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};

export type FileLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

export const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
export const FILE_LOCK_STALE_ERROR_CODE = "file_lock_stale";

export type FileLockTimeoutError = Error & {
  code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
  lockPath: string;
};

export type FileLockStaleError = Error & {
  code: typeof FILE_LOCK_STALE_ERROR_CODE;
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

export function resetFileLockStateForTest(): void {
  resetFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}

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
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
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
