import fs from "node:fs";
import {
  acquireFileLockSync,
  type FileLockSyncAcquireOptions,
  type FileLockSyncHandle,
} from "../../infra/file-lock-manager.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 20;
const STORAGE_LOCK_STALE_MS = 30_000;
let currentProcessStartTime: number | null | undefined;

export function acquireLockSyncWithRetry(path: string): () => void {
  const lock = acquireStorageLockSyncWithRetry(path);
  return () => lock.release();
}

function acquireStorageLockSyncWithRetry(path: string): FileLockSyncHandle {
  prepareStorageLockPathForFsSafe(path);
  return acquireFileLockSync(path, createStorageLockOptions());
}

function createStorageLockPayload(): Record<string, unknown> {
  currentProcessStartTime ??= getFileLockProcessStartTime(process.pid);
  return {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(currentProcessStartTime === null ? {} : { starttime: currentProcessStartTime }),
  };
}

function storageLockOwnerIsStale(payload: unknown): boolean {
  return isLockOwnerDefinitelyStale({
    payload:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null,
  });
}

function prepareStorageLockPathForFsSafe(targetPath: string): void {
  const lockPath = `${targetPath}.lock`;
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (observed.isFile() && !observed.isSymbolicLink()) {
    return;
  }
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error(`Storage lock path has an unsupported legacy type: ${lockPath}`);
  }
  throw Object.assign(
    new Error(
      `Legacy storage lock requires manual removal after verifying no older OpenClaw process is running: ${lockPath}`,
    ),
    { code: "file_lock_stale", lockPath },
  );
}

function createStorageLockOptions(): FileLockSyncAcquireOptions<Record<string, unknown>> {
  return {
    staleMs: STORAGE_LOCK_STALE_MS,
    retry: {
      retries: MAX_LOCK_ATTEMPTS - 1,
      factor: 1,
      minTimeout: LOCK_RETRY_DELAY_MS,
      maxTimeout: LOCK_RETRY_DELAY_MS,
      randomize: false,
    },
    staleRecovery: "remove-if-unchanged",
    payload: createStorageLockPayload,
    shouldReclaim: ({ payload }) => storageLockOwnerIsStale(payload),
    shouldRemoveStaleLock: ({ payload }) => storageLockOwnerIsStale(payload),
  };
}
