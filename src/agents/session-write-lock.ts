import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import { SessionWriteLockTimeoutError } from "./session-write-lock-error.js";

type LockFilePayload = {
  pid?: number;
  createdAt?: string;
  /** Process start time in clock ticks (from /proc/pid/stat field 22). */
  starttime?: number;
};

function isValidLockNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
  acquiredAt: number;
  maxHoldMs: number;
  releasePromise?: Promise<void>;
};

export type SessionLockInspection = {
  lockPath: string;
  pid: number | null;
  pidAlive: boolean;
  createdAt: string | null;
  ageMs: number | null;
  stale: boolean;
  staleReasons: string[];
  removed: boolean;
};

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
const CLEANUP_STATE_KEY = Symbol.for("openclaw.sessionWriteLockCleanupState");
const HELD_LOCKS_KEY = Symbol.for("openclaw.sessionWriteLockHeldLocks");
const WATCHDOG_STATE_KEY = Symbol.for("openclaw.sessionWriteLockWatchdogState");

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HOLD_MS = 5 * 60 * 1000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_GRACE_MS = 2 * 60 * 1000;
const MAX_LOCK_HOLD_MS = 2_147_000_000;

type CleanupState = {
  registered: boolean;
  exitHandler?: () => void;
  cleanupHandlers: Map<CleanupSignal, () => void>;
};

type WatchdogState = {
  started: boolean;
  intervalMs: number;
  timer?: NodeJS.Timeout;
};

type LockInspectionDetails = Pick<
  SessionLockInspection,
  "pid" | "pidAlive" | "createdAt" | "ageMs" | "stale" | "staleReasons"
>;

const HELD_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_LOCKS_KEY);

function resolveCleanupState(): CleanupState {
  const proc = process as NodeJS.Process & {
    [CLEANUP_STATE_KEY]?: CleanupState;
  };
  if (!proc[CLEANUP_STATE_KEY]) {
    proc[CLEANUP_STATE_KEY] = {
      registered: false,
      exitHandler: undefined,
      cleanupHandlers: new Map<CleanupSignal, () => void>(),
    };
  }
  return proc[CLEANUP_STATE_KEY];
}

function resolveWatchdogState(): WatchdogState {
  const proc = process as NodeJS.Process & {
    [WATCHDOG_STATE_KEY]?: WatchdogState;
  };
  if (!proc[WATCHDOG_STATE_KEY]) {
    proc[WATCHDOG_STATE_KEY] = {
      started: false,
      intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS,
    };
  }
  return proc[WATCHDOG_STATE_KEY];
}

function resolvePositiveMs(
  value: number | undefined,
  fallback: number,
  opts: { allowInfinity?: boolean } = {},
): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return fallback;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return opts.allowInfinity ? value : fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

export function resolveSessionLockMaxHoldFromTimeout(params: {
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
}): number {
  const minMs = resolvePositiveMs(params.minMs, DEFAULT_MAX_HOLD_MS);
  const timeoutMs = resolvePositiveMs(params.timeoutMs, minMs, { allowInfinity: true });
  if (timeoutMs === Number.POSITIVE_INFINITY) {
    return MAX_LOCK_HOLD_MS;
  }
  const graceMs = resolvePositiveMs(params.graceMs, DEFAULT_TIMEOUT_GRACE_MS);
  return Math.min(MAX_LOCK_HOLD_MS, Math.max(minMs, timeoutMs + graceMs));
}

async function releaseHeldLock(
  normalizedSessionFile: string,
  held: HeldLock,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const current = HELD_LOCKS.get(normalizedSessionFile);
  if (current !== held) {
    return false;
  }

  if (opts.force) {
    held.count = 0;
  } else {
    held.count -= 1;
    if (held.count > 0) {
      return false;
    }
  }

  if (held.releasePromise) {
    await held.releasePromise.catch(() => undefined);
    return true;
  }

  HELD_LOCKS.delete(normalizedSessionFile);
  held.releasePromise = (async () => {
    try {
      await held.handle.close();
    } catch {
      // Ignore errors during cleanup - best effort.
    }
    try {
      await fs.rm(held.lockPath, { force: true });
    } catch {
      // Ignore errors during cleanup - best effort.
    }
  })();

  try {
    await held.releasePromise;
    return true;
  } finally {
    held.releasePromise = undefined;
    if (HELD_LOCKS.size === 0) {
      stopWatchdogTimer();
    }
  }
}

/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
function releaseAllLocksSync(): void {
  for (const [sessionFile, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Ignore errors during cleanup - best effort
    }
    HELD_LOCKS.delete(sessionFile);
  }
  if (HELD_LOCKS.size === 0) {
    stopWatchdogTimer();
  }
}

async function runLockWatchdogCheck(nowMs = Date.now()): Promise<number> {
  let released = 0;
  for (const [sessionFile, held] of HELD_LOCKS.entries()) {
    const heldForMs = nowMs - held.acquiredAt;
    if (heldForMs <= held.maxHoldMs) {
      continue;
    }

    process.stderr.write(
      `[session-write-lock] releasing lock held for ${heldForMs}ms (max=${held.maxHoldMs}ms): ${held.lockPath}\n`,
    );

    const didRelease = await releaseHeldLock(sessionFile, held, { force: true });
    if (didRelease) {
      released += 1;
    }
  }
  return released;
}

function stopWatchdogTimer(): void {
  const watchdogState = resolveWatchdogState();
  if (watchdogState.timer) {
    clearInterval(watchdogState.timer);
    watchdogState.timer = undefined;
  }
  watchdogState.started = false;
}

function shouldStartBackgroundWatchdog(): boolean {
  return process.env.VITEST !== "true" || process.env.OPENCLAW_TEST_SESSION_LOCK_WATCHDOG === "1";
}

function ensureWatchdogStarted(intervalMs: number): void {
  if (!shouldStartBackgroundWatchdog()) {
    return;
  }
  const watchdogState = resolveWatchdogState();
  if (watchdogState.started) {
    return;
  }
  watchdogState.started = true;
  watchdogState.intervalMs = intervalMs;
  watchdogState.timer = setInterval(() => {
    void runLockWatchdogCheck().catch(() => {
      // Ignore watchdog errors - best effort cleanup only.
    });
  }, intervalMs);
  watchdogState.timer.unref?.();
}

function handleTerminationSignal(signal: CleanupSignal): void {
  releaseAllLocksSync();
  const cleanupState = resolveCleanupState();
  const shouldReraise = process.listenerCount(signal) === 1;
  if (shouldReraise) {
    const handler = cleanupState.cleanupHandlers.get(signal);
    if (handler) {
      process.off(signal, handler);
      cleanupState.cleanupHandlers.delete(signal);
    }
    try {
      process.kill(process.pid, signal);
    } catch {
      // Ignore errors during shutdown
    }
  }
}

function registerCleanupHandlers(): void {
  const cleanupState = resolveCleanupState();
  cleanupState.registered = true;
  if (!cleanupState.exitHandler) {
    // Cleanup on normal exit and process.exit() calls
    cleanupState.exitHandler = () => {
      releaseAllLocksSync();
    };
    process.on("exit", cleanupState.exitHandler);
  }

  ensureWatchdogStarted(DEFAULT_WATCHDOG_INTERVAL_MS);

  // Handle termination signals
  for (const signal of CLEANUP_SIGNALS) {
    if (cleanupState.cleanupHandlers.has(signal)) {
      continue;
    }
    try {
      const handler = () => handleTerminationSignal(signal);
      cleanupState.cleanupHandlers.set(signal, handler);
      process.on(signal, handler);
    } catch {
      // Ignore unsupported signals on this platform.
    }
  }
}

function unregisterCleanupHandlers(): void {
  const cleanupState = resolveCleanupState();
  if (cleanupState.exitHandler) {
    process.off("exit", cleanupState.exitHandler);
    cleanupState.exitHandler = undefined;
  }
  for (const [signal, handler] of cleanupState.cleanupHandlers) {
    process.off(signal, handler);
  }
  cleanupState.cleanupHandlers.clear();
  cleanupState.registered = false;
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload: LockFilePayload = {};
    if (isValidLockNumber(parsed.pid) && parsed.pid > 0) {
      payload.pid = parsed.pid;
    }
    if (typeof parsed.createdAt === "string") {
      payload.createdAt = parsed.createdAt;
    }
    if (isValidLockNumber(parsed.starttime)) {
      payload.starttime = parsed.starttime;
    }
    return payload;
  } catch {
    return null;
  }
}

function inspectLockPayload(
  payload: LockFilePayload | null,
  staleMs: number,
  nowMs: number,
): LockInspectionDetails {
  const pid = isValidLockNumber(payload?.pid) && payload.pid > 0 ? payload.pid : null;
  const pidAlive = pid !== null ? isPidAlive(pid) : false;
  const createdAt = typeof payload?.createdAt === "string" ? payload.createdAt : null;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;

  // Detect PID recycling: if the PID is alive but its start time differs from
  // what was recorded in the lock file, the original process died and the OS
  // reassigned the same PID to a different process.
  const storedStarttime = isValidLockNumber(payload?.starttime) ? payload.starttime : null;
  const pidRecycled =
    pidAlive && pid !== null && storedStarttime !== null
      ? (() => {
          const currentStarttime = getProcessStartTime(pid);
          return currentStarttime !== null && currentStarttime !== storedStarttime;
        })()
      : false;

  const staleReasons: string[] = [];
  if (pid === null) {
    staleReasons.push("missing-pid");
  } else if (!pidAlive) {
    staleReasons.push("dead-pid");
  } else if (pidRecycled) {
    staleReasons.push("recycled-pid");
  }
  if (ageMs === null) {
    staleReasons.push("invalid-createdAt");
  } else if (ageMs > staleMs) {
    staleReasons.push("too-old");
  }

  return {
    pid,
    pidAlive,
    createdAt,
    ageMs,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

function lockInspectionNeedsMtimeStaleFallback(details: LockInspectionDetails): boolean {
  return (
    details.stale &&
    details.staleReasons.every(
      (reason) => reason === "missing-pid" || reason === "invalid-createdAt",
    )
  );
}

async function shouldReclaimContendedLockFile(
  lockPath: string,
  details: LockInspectionDetails,
  staleMs: number,
  nowMs: number,
): Promise<boolean> {
  if (!details.stale) {
    return false;
  }
  if (!lockInspectionNeedsMtimeStaleFallback(details)) {
    return true;
  }
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Math.max(0, nowMs - stat.mtimeMs);
    return ageMs > staleMs;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return code !== "ENOENT";
  }
}

function shouldTreatAsOrphanSelfLock(params: {
  payload: LockFilePayload | null;
  normalizedSessionFile: string;
}): boolean {
  const pid = isValidLockNumber(params.payload?.pid) ? params.payload.pid : null;
  if (pid !== process.pid) {
    return false;
  }
  const hasValidStarttime = isValidLockNumber(params.payload?.starttime);
  if (hasValidStarttime) {
    return false;
  }
  return !HELD_LOCKS.has(params.normalizedSessionFile);
}

export async function cleanStaleLockFiles(params: {
  sessionsDir: string;
  staleMs?: number;
  removeStale?: boolean;
  nowMs?: number;
  log?: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
  };
}): Promise<{ locks: SessionLockInspection[]; cleaned: SessionLockInspection[] }> {
  const sessionsDir = path.resolve(params.sessionsDir);
  const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);
  const removeStale = params.removeStale !== false;
  const nowMs = params.nowMs ?? Date.now();

  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { locks: [], cleaned: [] };
    }
    throw err;
  }

  const locks: SessionLockInspection[] = [];
  const cleaned: SessionLockInspection[] = [];
  const lockEntries = entries
    .filter((entry) => entry.name.endsWith(".jsonl.lock"))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  for (const entry of lockEntries) {
    const lockPath = path.join(sessionsDir, entry.name);
    const payload = await readLockPayload(lockPath);
    const inspected = inspectLockPayload(payload, staleMs, nowMs);
    const lockInfo: SessionLockInspection = {
      lockPath,
      ...inspected,
      removed: false,
    };

    if (lockInfo.stale && removeStale) {
      await fs.rm(lockPath, { force: true });
      lockInfo.removed = true;
      cleaned.push(lockInfo);
      params.log?.warn?.(
        `removed stale session lock: ${lockPath} (${lockInfo.staleReasons.join(", ") || "unknown"})`,
      );
    }

    locks.push(lockInfo);
  }

  return { locks, cleaned };
}

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  allowReentrant?: boolean;
}): Promise<{
  release: () => Promise<void>;
}> {
  registerCleanupHandlers();
  const allowReentrant = params.allowReentrant ?? false;
  const timeoutMs = resolvePositiveMs(params.timeoutMs, 10_000, { allowInfinity: true });
  const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, DEFAULT_MAX_HOLD_MS);
  const sessionFile = path.resolve(params.sessionFile);
  const sessionDir = path.dirname(sessionFile);
  await fs.mkdir(sessionDir, { recursive: true });
  let normalizedDir = sessionDir;
  try {
    normalizedDir = await fs.realpath(sessionDir);
  } catch {
    // Fall back to the resolved path if realpath fails (permissions, transient FS).
  }
  const normalizedSessionFile = path.join(normalizedDir, path.basename(sessionFile));
  const lockPath = `${normalizedSessionFile}.lock`;

  const held = HELD_LOCKS.get(normalizedSessionFile);
  if (allowReentrant && held) {
    held.count += 1;
    return {
      release: async () => {
        await releaseHeldLock(normalizedSessionFile, held);
      },
    };
  }

  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx");
      const createdAt = new Date().toISOString();
      const starttime = getProcessStartTime(process.pid);
      const lockPayload: LockFilePayload = { pid: process.pid, createdAt };
      if (starttime !== null) {
        lockPayload.starttime = starttime;
      }
      await handle.writeFile(JSON.stringify(lockPayload, null, 2), "utf8");
      const createdHeld: HeldLock = {
        count: 1,
        handle,
        lockPath,
        acquiredAt: Date.now(),
        maxHoldMs,
      };
      HELD_LOCKS.set(normalizedSessionFile, createdHeld);
      return {
        release: async () => {
          await releaseHeldLock(normalizedSessionFile, createdHeld);
        },
      };
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Ignore cleanup errors on failed lock initialization.
        }
        try {
          await fs.rm(lockPath, { force: true });
        } catch {
          // Ignore cleanup errors on failed lock initialization.
        }
      }
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      const payload = await readLockPayload(lockPath);
      const nowMs = Date.now();
      const inspected = inspectLockPayload(payload, staleMs, nowMs);
      const orphanSelfLock = shouldTreatAsOrphanSelfLock({
        payload,
        normalizedSessionFile,
      });
      const reclaimDetails = orphanSelfLock
        ? {
            ...inspected,
            stale: true,
            staleReasons: inspected.staleReasons.includes("orphan-self-pid")
              ? inspected.staleReasons
              : [...inspected.staleReasons, "orphan-self-pid"],
          }
        : inspected;
      if (await shouldReclaimContendedLockFile(lockPath, reclaimDetails, staleMs, nowMs)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        break;
      }
      const delay = Math.min(1000, 50 * attempt, remainingMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const payload = await readLockPayload(lockPath);
  const owner = typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown";
  throw new SessionWriteLockTimeoutError({ timeoutMs, owner, lockPath });
}

export const __testing = {
  cleanupSignals: [...CLEANUP_SIGNALS],
  handleTerminationSignal,
  releaseAllLocksSync,
  runLockWatchdogCheck,
};

export async function drainSessionWriteLockStateForTest(): Promise<void> {
  for (const [sessionFile, held] of Array.from(HELD_LOCKS.entries())) {
    await releaseHeldLock(sessionFile, held, { force: true }).catch(() => undefined);
  }
  stopWatchdogTimer();
  unregisterCleanupHandlers();
}

export function resetSessionWriteLockStateForTest(): void {
  releaseAllLocksSync();
  stopWatchdogTimer();
  unregisterCleanupHandlers();
}
