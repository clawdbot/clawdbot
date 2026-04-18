import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";

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

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

const HELD_LOCKS_KEY = Symbol.for("openclaw.fileLockHeldLocks");
const HELD_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_LOCKS_KEY);
const CLEANUP_REGISTERED_KEY = Symbol.for("openclaw.fileLockCleanupRegistered");

function releaseAllLocksSync(): void {
  for (const [normalizedFile, held] of HELD_LOCKS) {
    // Kick off best-effort async closes before dropping references so tests
    // don't leave FileHandle objects for GC to close later.
    void held.handle.close().catch(() => undefined);
    rmLockPathSync(held.lockPath);
    HELD_LOCKS.delete(normalizedFile);
  }
}

async function drainAllLocks(): Promise<void> {
  for (const [normalizedFile, held] of Array.from(HELD_LOCKS.entries())) {
    HELD_LOCKS.delete(normalizedFile);
    await held.handle.close().catch(() => undefined);
    await fs.rm(held.lockPath, { force: true }).catch(() => undefined);
  }
}

function rmLockPathSync(lockPath: string): void {
  try {
    fsSync.rmSync(lockPath, { force: true });
  } catch {
    // Best-effort exit cleanup only.
  }
}

function ensureExitCleanupRegistered(): void {
  const proc = process as NodeJS.Process & { [CLEANUP_REGISTERED_KEY]?: boolean };
  if (proc[CLEANUP_REGISTERED_KEY]) {
    return;
  }
  proc[CLEANUP_REGISTERED_KEY] = true;
  process.on("exit", releaseAllLocksSync);
}

function computeDelayMs(retries: FileLockOptions["retries"], attempt: number): number {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function resolveNormalizedFilePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
      return true;
    }
  }
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

export type FileLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

export const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";

export type FileLockTimeoutError = Error & {
  code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
  lockPath: string;
};

function createFileLockTimeoutError(
  normalizedFile: string,
  lockPath: string,
): FileLockTimeoutError {
  const error = new Error(`file lock timeout for ${normalizedFile}`);
  return Object.assign(error, {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  }) as FileLockTimeoutError;
}

async function releaseHeldLock(normalizedFile: string): Promise<void> {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) {
    return;
  }
  current.count -= 1;
  if (current.count > 0) {
    return;
  }
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

export function resetFileLockStateForTest(): void {
  releaseAllLocksSync();
}

export async function drainFileLockStateForTest(): Promise<void> {
  await drainAllLocks();
}

/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<FileLockHandle> {
  ensureExitCleanupRegistered();
  const normalizedFile = await resolveNormalizedFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return {
      lockPath,
      release: () => releaseHeldLock(normalizedFile),
    };
  }

  for (let attempt = 0; attempt <= options.retries.retries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return {
        lockPath,
        release: () => releaseHeldLock(normalizedFile),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await isStaleLock(lockPath, options.stale)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= options.retries.retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw createFileLockTimeoutError(normalizedFile, lockPath);
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
