import fs from "node:fs";
import path from "node:path";
import { getProcessStartTime } from "../shared/pid-alive.js";

export const BUNDLED_RUNTIME_DEPS_LOCK_DIR = ".openclaw-runtime-deps.lock";

const BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE = "owner.json";
const BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS = 100;
const BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS = 5 * 60_000;
const BUNDLED_RUNTIME_DEPS_LOCK_STALE_MS = 10 * 60_000;
const BUNDLED_RUNTIME_DEPS_OWNERLESS_LOCK_STALE_MS = 30_000;

type RuntimeDepsLockOwner = {
  pid?: number;
  starttime?: number;
  createdAtMs?: number;
  ownerFileState: "ok" | "missing" | "invalid";
  ownerFilePath: string;
  ownerFileMtimeMs?: number;
  ownerFileIsSymlink?: boolean;
  lockDirMtimeMs?: number;
};

const CURRENT_PROCESS_STARTTIME = getProcessStartTime(process.pid);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRuntimeDepsLockOwner(lockDir: string): RuntimeDepsLockOwner {
  const ownerFilePath = path.join(lockDir, BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE);
  let owner: Record<string, unknown> | null = null;
  let ownerFileState: RuntimeDepsLockOwner["ownerFileState"] = "missing";
  let ownerFileMtimeMs: number | undefined;
  let ownerFileIsSymlink: boolean | undefined;
  try {
    const ownerFileStat = fs.lstatSync(ownerFilePath);
    ownerFileMtimeMs = ownerFileStat.mtimeMs;
    ownerFileIsSymlink = ownerFileStat.isSymbolicLink();
  } catch {
    // The owner file may not exist yet, or may have been removed by the lock owner.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFilePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      owner = parsed as Record<string, unknown>;
      ownerFileState = "ok";
    } else {
      ownerFileState = "invalid";
    }
  } catch (error) {
    ownerFileState =
      (error as NodeJS.ErrnoException).code === "ENOENT" && ownerFileMtimeMs === undefined
        ? "missing"
        : "invalid";
  }
  let lockDirMtimeMs: number | undefined;
  try {
    lockDirMtimeMs = fs.statSync(lockDir).mtimeMs;
  } catch {
    // The lock may have disappeared between the mkdir failure and diagnostics.
  }
  return {
    pid: typeof owner?.pid === "number" ? owner.pid : undefined,
    starttime: typeof owner?.starttime === "number" ? owner.starttime : undefined,
    createdAtMs: typeof owner?.createdAtMs === "number" ? owner.createdAtMs : undefined,
    ownerFileState,
    ownerFilePath,
    ownerFileMtimeMs,
    ownerFileIsSymlink,
    lockDirMtimeMs,
  };
}

function latestFiniteMs(values: readonly (number | undefined)[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    if (latest === undefined || value > latest) {
      latest = value;
    }
  }
  return latest;
}

export function shouldRemoveRuntimeDepsLock(
  owner: Pick<
    RuntimeDepsLockOwner,
    "pid" | "starttime" | "createdAtMs" | "lockDirMtimeMs" | "ownerFileMtimeMs"
  >,
  nowMs: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
  readStarttime: (pid: number) => number | null = getProcessStartTime,
): boolean {
  if (typeof owner.pid === "number") {
    if (!isAlive(owner.pid)) {
      return true;
    }
    if (typeof owner.starttime === "number") {
      const liveStarttime = readStarttime(owner.pid);
      if (liveStarttime !== null && liveStarttime !== owner.starttime) {
        return true;
      }
    }
    return false;
  }

  if (typeof owner.createdAtMs === "number") {
    return nowMs - owner.createdAtMs > BUNDLED_RUNTIME_DEPS_LOCK_STALE_MS;
  }

  const ownerlessObservedAtMs = latestFiniteMs([owner.lockDirMtimeMs, owner.ownerFileMtimeMs]);
  return (
    typeof ownerlessObservedAtMs === "number" &&
    nowMs - ownerlessObservedAtMs > BUNDLED_RUNTIME_DEPS_OWNERLESS_LOCK_STALE_MS
  );
}

function formatDurationMs(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.max(0, Math.round(ms))}ms` : "n/a";
}

export function formatRuntimeDepsLockTimeoutMessage(params: {
  lockDir: string;
  owner: RuntimeDepsLockOwner;
  waitedMs: number;
  nowMs: number;
}): string {
  const ownerAgeMs =
    typeof params.owner.createdAtMs === "number"
      ? params.nowMs - params.owner.createdAtMs
      : undefined;
  const lockAgeMs =
    typeof params.owner.lockDirMtimeMs === "number"
      ? params.nowMs - params.owner.lockDirMtimeMs
      : undefined;
  const ownerFileAgeMs =
    typeof params.owner.ownerFileMtimeMs === "number"
      ? params.nowMs - params.owner.ownerFileMtimeMs
      : undefined;
  const pidDetail =
    typeof params.owner.pid === "number"
      ? `pid=${params.owner.pid} alive=${isProcessAlive(params.owner.pid)}`
      : "pid=missing";
  const ownerFileSymlink =
    typeof params.owner.ownerFileIsSymlink === "boolean" ? params.owner.ownerFileIsSymlink : "n/a";
  return (
    `Timed out waiting for bundled runtime deps lock at ${params.lockDir} ` +
    `(waited=${formatDurationMs(params.waitedMs)}, ownerFile=${params.owner.ownerFileState}, ownerFileSymlink=${ownerFileSymlink}, ` +
    `${pidDetail}, ownerAge=${formatDurationMs(ownerAgeMs)}, ownerFileAge=${formatDurationMs(ownerFileAgeMs)}, lockAge=${formatDurationMs(lockAgeMs)}, ` +
    `ownerFilePath=${params.owner.ownerFilePath}). If no OpenClaw/npm install is running, remove the lock directory and retry.`
  );
}

export function removeRuntimeDepsLockIfStale(lockDir: string, nowMs: number): boolean {
  const owner = readRuntimeDepsLockOwner(lockDir);
  if (!shouldRemoveRuntimeDepsLock(owner, nowMs)) {
    return false;
  }

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function writeRuntimeDepsLockOwner(lockDir: string): void {
  try {
    fs.writeFileSync(
      path.join(lockDir, BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE),
      `${JSON.stringify(
        {
          pid: process.pid,
          ...(typeof CURRENT_PROCESS_STARTTIME === "number"
            ? { starttime: CURRENT_PROCESS_STARTTIME }
            : {}),
          createdAtMs: Date.now(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (ownerWriteError) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw ownerWriteError;
  }
}

function tryAcquireRuntimeDepsLock(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir);
    writeRuntimeDepsLockOwner(lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

function createRuntimeDepsLockTimeoutError(params: {
  lockDir: string;
  startedAt: number;
  nowMs: number;
  cause: unknown;
}): Error {
  return new Error(
    formatRuntimeDepsLockTimeoutMessage({
      lockDir: params.lockDir,
      owner: readRuntimeDepsLockOwner(params.lockDir),
      waitedMs: params.nowMs - params.startedAt,
      nowMs: params.nowMs,
    }),
    { cause: params.cause },
  );
}

export function withBundledRuntimeDepsFilesystemLock<T>(
  installRoot: string,
  lockName: string,
  run: () => T,
): T {
  fs.mkdirSync(installRoot, { recursive: true });
  const lockDir = path.join(installRoot, lockName);
  const startedAt = Date.now();
  let locked = false;
  while (!locked) {
    locked = tryAcquireRuntimeDepsLock(lockDir);
    if (!locked) {
      removeRuntimeDepsLockIfStale(lockDir, Date.now());
      const nowMs = Date.now();
      if (nowMs - startedAt > BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS) {
        throw createRuntimeDepsLockTimeoutError({
          lockDir,
          startedAt,
          nowMs,
          cause: new Error("runtime deps lock already exists"),
        });
      }
      sleepSync(BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS);
    }
  }
  try {
    return run();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function withBundledRuntimeDepsFilesystemLockAsync<T>(
  installRoot: string,
  lockName: string,
  run: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(installRoot, { recursive: true });
  const lockDir = path.join(installRoot, lockName);
  const startedAt = Date.now();
  let locked = false;
  while (!locked) {
    locked = tryAcquireRuntimeDepsLock(lockDir);
    if (!locked) {
      removeRuntimeDepsLockIfStale(lockDir, Date.now());
      const nowMs = Date.now();
      if (nowMs - startedAt > BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS) {
        throw createRuntimeDepsLockTimeoutError({
          lockDir,
          startedAt,
          nowMs,
          cause: new Error("runtime deps lock already exists"),
        });
      }
      await sleep(BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS);
    }
  }
  try {
    return await run();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
