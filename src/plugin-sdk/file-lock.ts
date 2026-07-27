// File lock helpers serialize plugin writes that share a filesystem-backed state file.
import "../infra/fs-safe-defaults.js";
import fs from "node:fs/promises";
import {
  acquireFileLock as acquireFsSafeFileLock,
  drainFileLockManagerForTest,
  resetFileLockManagerForTest,
} from "@openclaw/fs-safe/file-lock";
import {
  isLockOwnerDefinitelyStale,
  shouldRemoveDeadOwnerOrExpiredLock,
} from "../infra/stale-lock-file.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";

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
  /** Milliseconds used to classify contended sidecars as stale. */
  stale: number;
  /** Fail closed for security-sensitive state; generic locks retain shipped stale recovery. */
  staleRecovery?: "fail-closed" | "remove-if-unchanged";
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
const STALE_FILE_LOCK_RECLAIM_MANAGER_KEY = "openclaw.plugin-sdk.stale-file-lock-reclaim";
let currentProcessStartTime: number | null | undefined;

function getCurrentProcessStartTime(): number | null {
  if (currentProcessStartTime === undefined) {
    currentProcessStartTime = getFileLockProcessStartTime(process.pid);
  }
  return currentProcessStartTime;
}

function createCurrentProcessLockPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const starttime = getCurrentProcessStartTime();
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  return payload;
}

function sameStatValue(left: number | bigint, right: number | bigint): boolean {
  return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right);
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  if (!sameStatValue(left.ino, right.ino)) {
    return false;
  }
  if (sameStatValue(left.dev, right.dev)) {
    return true;
  }
  // Windows path stats may report dev=0 while fd stats know the volume id.
  return (
    process.platform === "win32" &&
    (left.dev === 0 || left.dev === 0n || right.dev === 0 || right.dev === 0n)
  );
}

async function isSameRegularFile(
  filePath: string,
  observed: { dev: number | bigint; ino: number | bigint },
): Promise<boolean> {
  try {
    const current = await fs.lstat(filePath, { bigint: true });
    return current.isFile() && sameFileIdentity(current, observed);
  } catch {
    return false;
  }
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
  const staleRecovery = options.staleRecovery ?? "remove-if-unchanged";
  try {
    const lock = await acquireFsSafeFileLock(filePath, {
      managerKey: FILE_LOCK_MANAGER_KEY,
      staleMs: options.stale,
      retry: options.retries,
      staleRecovery,
      allowReentrant: true,
      payload: createCurrentProcessLockPayload,
      shouldReclaim: (params) =>
        staleRecovery === "fail-closed"
          ? isLockOwnerDefinitelyStale({ payload: params.payload })
          : shouldRemoveDeadOwnerOrExpiredLock({
              payload: params.payload,
              staleMs: params.staleMs,
              nowMs: params.nowMs,
            }),
      ...(staleRecovery === "remove-if-unchanged"
        ? {
            shouldRemoveStaleLock: (snapshot: { payload: Record<string, unknown> | null }) =>
              shouldRemoveDeadOwnerOrExpiredLock({
                payload: snapshot.payload,
                staleMs: options.stale,
              }),
          }
        : {}),
    });
    return { lockPath: lock.lockPath, release: lock.release };
  } catch (err) {
    return normalizeLockError(err);
  }
}

/** Result of a doctor-owned attempt to remove one retired file-lock sidecar. */
export type StaleFileLockReclaimResult = "missing" | "removed" | "retained";

/** Remove one definitely stale, unchanged regular lock sidecar; retain every ambiguous owner. */
export async function reclaimDefinitelyStaleFileLock(
  lockPath: string,
): Promise<StaleFileLockReclaimResult> {
  let observed: { dev: number | bigint; ino: number | bigint; isFile: () => boolean };
  try {
    observed = await fs.lstat(lockPath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw err;
  }
  if (!observed.isFile()) {
    return "retained";
  }

  // Pin approval to the regular-file identity first observed. fs-safe then
  // rechecks that identity and raw payload immediately before path removal.
  const ownerIsDefinitelyStale = async (payload: Record<string, unknown> | null) =>
    (await isSameRegularFile(lockPath, observed)) && isLockOwnerDefinitelyStale({ payload });
  const targetPath = lockPath.endsWith(".lock") ? lockPath.slice(0, -".lock".length) : lockPath;
  try {
    const reclaimed = await acquireFsSafeFileLock(targetPath, {
      managerKey: STALE_FILE_LOCK_RECLAIM_MANAGER_KEY,
      lockPath,
      staleMs: 0,
      retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged",
      payload: createCurrentProcessLockPayload,
      shouldReclaim: ({ payload }) => ownerIsDefinitelyStale(payload),
      shouldRemoveStaleLock: ({ payload }) => ownerIsDefinitelyStale(payload),
    });
    await reclaimed.release();
    return "removed";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === FILE_LOCK_TIMEOUT_ERROR_CODE || code === FILE_LOCK_STALE_ERROR_CODE) {
      return "retained";
    }
    throw err;
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
