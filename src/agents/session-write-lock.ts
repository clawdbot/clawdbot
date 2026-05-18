import "../infra/fs-safe-defaults.js";
import type fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import { readGatewayProcessArgsSync as readProcessArgsSync } from "../infra/gateway-processes.js";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
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

export type SessionLockOwnerProcessArgsReader = (pid: number) => string[] | null;

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
const CLEANUP_STATE_KEY = Symbol.for("openclaw.sessionWriteLockCleanupState");
const WATCHDOG_STATE_KEY = Symbol.for("openclaw.sessionWriteLockWatchdogState");

export const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30 * 60 * 1000;
export const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_GRACE_MS = 2 * 60 * 1000;
// A payload-less lock can be left behind if shutdown lands between open("wx")
// and the owner metadata write. Keep the grace short so 10s callers recover.
const ORPHAN_LOCK_PAYLOAD_GRACE_MS = 5_000;
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

const SESSION_LOCKS = createFileLockManager("openclaw.session-write-lock");
let resolveProcessStartTimeForLock = getProcessStartTime;

function isFileLockError(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

export type SessionWriteLockAcquireTimeoutConfig = {
  session?: {
    writeLock?: {
      acquireTimeoutMs?: number;
      staleMs?: number;
      maxHoldMs?: number;
    };
  };
};

type SessionWriteLockMsKey = "acquireTimeoutMs" | "staleMs" | "maxHoldMs";

const SESSION_WRITE_LOCK_ENV: Record<SessionWriteLockMsKey, string> = {
  acquireTimeoutMs: "OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS",
  staleMs: "OPENCLAW_SESSION_WRITE_LOCK_STALE_MS",
  maxHoldMs: "OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS",
};

function readPositiveMsEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  opts: { allowInfinity?: boolean } = {},
): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return parsePositiveMs(value, opts);
}

function parsePositiveMs(
  value: number | undefined,
  opts: { allowInfinity?: boolean } = {},
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return undefined;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return opts.allowInfinity ? value : undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function resolveSessionWriteLockMs(params: {
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  key: SessionWriteLockMsKey;
  fallback: number;
  allowInfinity?: boolean;
}): number {
  const opts = { allowInfinity: params.allowInfinity };
  return (
    readPositiveMsEnv(params.env ?? process.env, SESSION_WRITE_LOCK_ENV[params.key], opts) ??
    parsePositiveMs(params.config?.session?.writeLock?.[params.key], opts) ??
    params.fallback
  );
}

export function resolveSessionWriteLockAcquireTimeoutMs(
  config?: SessionWriteLockAcquireTimeoutConfig,
  env?: NodeJS.ProcessEnv,
): number {
  return resolveSessionWriteLockMs({
    config,
    env,
    key: "acquireTimeoutMs",
    fallback: DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS,
    allowInfinity: true,
  });
}

export function resolveSessionWriteLockStaleMs(
  config?: SessionWriteLockAcquireTimeoutConfig,
  env?: NodeJS.ProcessEnv,
): number {
  return resolveSessionWriteLockMs({
    config,
    env,
    key: "staleMs",
    fallback: DEFAULT_SESSION_WRITE_LOCK_STALE_MS,
  });
}

export function resolveSessionWriteLockMaxHoldMs(
  config?: SessionWriteLockAcquireTimeoutConfig,
  params: { env?: NodeJS.ProcessEnv; fallback?: number } = {},
): number {
  return resolveSessionWriteLockMs({
    config,
    env: params.env,
    key: "maxHoldMs",
    fallback: params.fallback ?? DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS,
  });
}

export function resolveSessionWriteLockOptions(
  config?: SessionWriteLockAcquireTimeoutConfig,
  params: { env?: NodeJS.ProcessEnv; maxHoldMsFallback?: number } = {},
): { timeoutMs: number; staleMs: number; maxHoldMs: number } {
  return {
    timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(config, params.env),
    staleMs: resolveSessionWriteLockStaleMs(config, params.env),
    maxHoldMs: resolveSessionWriteLockMaxHoldMs(config, {
      env: params.env,
      fallback: params.maxHoldMsFallback,
    }),
  };
}

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
  const minMs = resolvePositiveMs(params.minMs, DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS);
  const timeoutMs = resolvePositiveMs(params.timeoutMs, minMs, { allowInfinity: true });
  if (timeoutMs === Number.POSITIVE_INFINITY) {
    return MAX_LOCK_HOLD_MS;
  }
  const graceMs = resolvePositiveMs(params.graceMs, DEFAULT_TIMEOUT_GRACE_MS);
  return Math.min(MAX_LOCK_HOLD_MS, Math.max(minMs, timeoutMs + graceMs));
}

/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
function releaseAllLocksSync(): void {
  SESSION_LOCKS.reset();
  stopWatchdogTimer();
}

async function runLockWatchdogCheck(nowMs = Date.now()): Promise<number> {
  let released = 0;
  for (const held of SESSION_LOCKS.heldEntries()) {
    const maxHoldMs =
      typeof held.metadata.maxHoldMs === "number"
        ? held.metadata.maxHoldMs
        : DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS;
    const heldForMs = nowMs - held.acquiredAt;
    if (heldForMs <= maxHoldMs) {
      continue;
    }

    process.stderr.write(
      `[session-write-lock] releasing lock held for ${heldForMs}ms (max=${maxHoldMs}ms): ${held.lockPath}\n`,
    );

    const didRelease = await held.forceRelease();
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

async function resolveNormalizedSessionFile(sessionFile: string): Promise<string> {
  const resolvedSessionFile = path.resolve(sessionFile);
  const sessionDir = path.dirname(resolvedSessionFile);
  try {
    const normalizedDir = await fs.realpath(sessionDir);
    return path.join(normalizedDir, path.basename(resolvedSessionFile));
  } catch {
    return resolvedSessionFile;
  }
}

function normalizeOwnerProcessArg(arg: string): string {
  return arg.trim().replaceAll("\\", "/").toLowerCase();
}

function isOpenClawSessionOwnerArgv(args: string[]): boolean {
  const normalized = args.map(normalizeOwnerProcessArg).filter(Boolean);
  if (normalized.length === 0) {
    return false;
  }
  const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  if (exe === "openclaw" || exe.endsWith("/openclaw") || exe.endsWith("/openclaw-gateway")) {
    return true;
  }
  if (
    normalized.some(
      (arg) =>
        arg === "openclaw" ||
        arg.endsWith("/openclaw") ||
        arg === "openclaw.mjs" ||
        arg.endsWith("/openclaw.mjs"),
    )
  ) {
    return true;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "scripts/run-node.mjs",
    "src/entry.ts",
    "src/index.ts",
  ];
  const hasOpenClawCommandToken = normalized.some((arg) => arg === "gateway" || arg === "agent");
  return normalized.some(
    (arg) => entryCandidates.some((entry) => arg.endsWith(entry)) && hasOpenClawCommandToken,
  );
}

function readOwnerProcessArgs(
  reader: SessionLockOwnerProcessArgsReader,
  pid: number,
): string[] | null {
  try {
    const args = reader(pid);
    return Array.isArray(args) ? args : null;
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
          const currentStarttime = resolveProcessStartTimeForLock(pid);
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

function shouldTreatAsNonOpenClawOwner(params: {
  payload: LockFilePayload | null;
  inspected: LockInspectionDetails;
  heldByThisProcess: boolean;
  readOwnerProcessArgs: SessionLockOwnerProcessArgsReader;
}): boolean {
  if (params.inspected.stale || params.inspected.pid === null || !params.inspected.pidAlive) {
    return false;
  }
  if (params.inspected.pid === process.pid && params.heldByThisProcess) {
    return false;
  }
  if (!isValidLockNumber(params.payload?.pid) || params.payload.pid <= 0) {
    return false;
  }

  const args = readOwnerProcessArgs(params.readOwnerProcessArgs, params.payload.pid);
  if (!args || args.every((arg) => !arg.trim())) {
    return false;
  }
  return !isOpenClawSessionOwnerArgv(args);
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
    return ageMs > Math.min(staleMs, ORPHAN_LOCK_PAYLOAD_GRACE_MS);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return code !== "ENOENT";
  }
}

function sessionLockHeldByThisProcess(normalizedSessionFile: string): boolean {
  return SESSION_LOCKS.heldEntries().some(
    (entry) => entry.normalizedTargetPath === normalizedSessionFile,
  );
}

async function removeReportedStaleLockIfStillStale(params: {
  lockPath: string;
  normalizedSessionFile: string;
  staleMs: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<boolean> {
  const nowMs = Date.now();
  const payload = await readLockPayload(params.lockPath);
  const inspected = inspectLockPayloadForSession({
    payload,
    staleMs: params.staleMs,
    nowMs,
    heldByThisProcess: sessionLockHeldByThisProcess(params.normalizedSessionFile),
    reclaimLockWithoutStarttime: true,
    readOwnerProcessArgs: params.readOwnerProcessArgs ?? readProcessArgsSync,
  });
  if (!(await shouldReclaimContendedLockFile(params.lockPath, inspected, params.staleMs, nowMs))) {
    return false;
  }
  await fs.rm(params.lockPath, { force: true });
  return true;
}

function shouldTreatAsOrphanSelfLock(params: {
  payload: LockFilePayload | null;
  heldByThisProcess: boolean;
  reclaimLockWithoutStarttime: boolean;
}): boolean {
  const pid = isValidLockNumber(params.payload?.pid) ? params.payload.pid : null;
  if (pid !== process.pid) {
    return false;
  }
  if (params.heldByThisProcess) {
    return false;
  }

  const storedStarttime = isValidLockNumber(params.payload?.starttime)
    ? params.payload.starttime
    : null;
  if (storedStarttime === null) {
    return params.reclaimLockWithoutStarttime;
  }

  const currentStarttime = resolveProcessStartTimeForLock(process.pid);
  return currentStarttime !== null && currentStarttime === storedStarttime;
}

function inspectLockPayloadForSession(params: {
  payload: LockFilePayload | null;
  staleMs: number;
  nowMs: number;
  heldByThisProcess: boolean;
  reclaimLockWithoutStarttime: boolean;
  readOwnerProcessArgs: SessionLockOwnerProcessArgsReader;
}): LockInspectionDetails {
  const inspected = inspectLockPayload(params.payload, params.staleMs, params.nowMs);
  if (
    shouldTreatAsOrphanSelfLock({
      payload: params.payload,
      heldByThisProcess: params.heldByThisProcess,
      reclaimLockWithoutStarttime: params.reclaimLockWithoutStarttime,
    })
  ) {
    return {
      ...inspected,
      stale: true,
      staleReasons: inspected.staleReasons.includes("orphan-self-pid")
        ? inspected.staleReasons
        : [...inspected.staleReasons, "orphan-self-pid"],
    };
  }

  if (
    shouldTreatAsNonOpenClawOwner({
      payload: params.payload,
      inspected,
      heldByThisProcess: params.heldByThisProcess,
      readOwnerProcessArgs: params.readOwnerProcessArgs,
    })
  ) {
    return {
      ...inspected,
      stale: true,
      staleReasons: [...inspected.staleReasons, "non-openclaw-owner"],
    };
  }

  return inspected;
}

export async function cleanStaleLockFiles(params: {
  sessionsDir: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  removeStale?: boolean;
  nowMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
  log?: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
  };
}): Promise<{ locks: SessionLockInspection[]; cleaned: SessionLockInspection[] }> {
  const sessionsDir = path.resolve(params.sessionsDir);
  const staleMs = resolvePositiveMs(
    params.staleMs,
    resolveSessionWriteLockStaleMs(params.config, params.env),
  );
  const removeStale = params.removeStale !== false;
  const nowMs = params.nowMs ?? Date.now();
  const ownerProcessArgsReader = params.readOwnerProcessArgs ?? readProcessArgsSync;

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
    const inspected = inspectLockPayloadForSession({
      payload,
      staleMs,
      nowMs,
      heldByThisProcess: false,
      reclaimLockWithoutStarttime: false,
      readOwnerProcessArgs: ownerProcessArgsReader,
    });
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
  const defaultOptions = resolveSessionWriteLockOptions();
  const timeoutMs = resolvePositiveMs(params.timeoutMs, defaultOptions.timeoutMs, {
    allowInfinity: true,
  });
  const staleMs = resolvePositiveMs(params.staleMs, defaultOptions.staleMs);
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, defaultOptions.maxHoldMs);
  const sessionFile = path.resolve(params.sessionFile);
  const sessionDir = path.dirname(sessionFile);
  const normalizedSessionFile = await resolveNormalizedSessionFile(sessionFile);
  const lockPath = `${normalizedSessionFile}.lock`;
  await fs.mkdir(sessionDir, { recursive: true });
  while (true) {
    try {
      const lock = await SESSION_LOCKS.acquire(sessionFile, {
        staleMs,
        timeoutMs,
        retry: { minTimeout: 50, maxTimeout: 1000, factor: 1 },
        allowReentrant,
        metadata: { maxHoldMs },
        payload: () => {
          const createdAt = new Date().toISOString();
          const starttime = resolveProcessStartTimeForLock(process.pid);
          const lockPayload: LockFilePayload = { pid: process.pid, createdAt };
          if (starttime !== null) {
            lockPayload.starttime = starttime;
          }
          return lockPayload as Record<string, unknown>;
        },
        shouldReclaim: async ({ payload, nowMs, heldByThisProcess }) => {
          const inspected = inspectLockPayloadForSession({
            payload: payload as LockFilePayload | null,
            staleMs,
            nowMs,
            heldByThisProcess,
            reclaimLockWithoutStarttime: true,
            readOwnerProcessArgs: readProcessArgsSync,
          });
          return await shouldReclaimContendedLockFile(lockPath, inspected, staleMs, nowMs);
        },
      });
      return { release: lock.release };
    } catch (err) {
      if (isFileLockError(err, "file_lock_stale")) {
        const staleLockPath = (err as { lockPath?: string }).lockPath ?? lockPath;
        if (
          await removeReportedStaleLockIfStillStale({
            lockPath: staleLockPath,
            normalizedSessionFile,
            staleMs,
          })
        ) {
          continue;
        }
      }
      if (!isFileLockError(err, "file_lock_timeout")) {
        throw err;
      }
      const timeoutLockPath = (err as { lockPath?: string }).lockPath ?? lockPath;
      const payload = await readLockPayload(timeoutLockPath);
      const owner = typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown";
      throw new SessionWriteLockTimeoutError({ timeoutMs, owner, lockPath: timeoutLockPath });
    }
  }
}

export const __testing = {
  cleanupSignals: [...CLEANUP_SIGNALS],
  handleTerminationSignal,
  releaseAllLocksSync,
  runLockWatchdogCheck,
  setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void {
    resolveProcessStartTimeForLock = resolver ?? getProcessStartTime;
  },
};

export async function drainSessionWriteLockStateForTest(): Promise<void> {
  await SESSION_LOCKS.drain();
  stopWatchdogTimer();
  unregisterCleanupHandlers();
}

export function resetSessionWriteLockStateForTest(): void {
  releaseAllLocksSync();
  stopWatchdogTimer();
  unregisterCleanupHandlers();
  resolveProcessStartTimeForLock = getProcessStartTime;
}
