/**
 * Session write-lock implementation.
 *
 * Uses lock files with owner metadata, stale detection, signal cleanup, and watchdog checks to serialize writes.
 */
import "../infra/fs-safe-defaults.js";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { readGatewayProcessArgsSync as readProcessArgsSync } from "../infra/gateway-processes.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isSqliteLockError } from "../infra/sqlite-transaction.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-port-pids.js";
import { LEGACY_IMPLICIT_AGENT_ID, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "./session-write-lock-error.js";

type LockFilePayload = {
  pid?: number;
  createdAt?: string;
  /** Process start time in clock ticks (from /proc/pid/stat field 22). */
  starttime?: number;
  maxHoldMs?: number;
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
  removable: boolean;
  removed: boolean;
};

export type SessionLockOwnerProcessArgsReader = (pid: number) => string[] | null;

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
const CLEANUP_STATE_KEY = Symbol.for("openclaw.sessionWriteLockCleanupState");
const WATCHDOG_STATE_KEY = Symbol.for("openclaw.sessionWriteLockWatchdogState");

const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const ABORTABLE_SESSION_WRITE_LOCK_POLL_MS = 100;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_GRACE_MS = 2 * 60 * 1000;
const REPORT_ONLY_STALE_LOCK_REASONS = new Set(["too-old", "hold-exceeded"]);
// Session-key leases are introduced with SQLite transcript ownership; there is
// no older shipped lease backend that requires dual acquisition during upgrade.
const SESSION_KEY_WRITE_LEASE_SCOPE = "session-write";
const SESSION_KEY_WRITE_LEASE_STATE_KEY = Symbol.for("openclaw.sessionWriteLeaseState");
const SESSION_KEY_WRITE_LEASE_BACKOFF = {
  initialMs: 25,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;
const SESSION_KEY_WRITE_LEASE_RELEASE_RETRY_MS = 2_000;
const defaultProcessStartTimeForLock = (pid: number): number | null =>
  process.platform === "win32"
    ? readWindowsProcessStartTimeSync(pid, 1_000)
    : getFileLockProcessStartTime(pid);
let resolveProcessStartTimeForLock = defaultProcessStartTimeForLock;

type SessionKeyWriteLeaseEntry = {
  databaseOptions: OpenClawAgentDatabaseOptions;
  owner: string;
  refCount: number;
};

type SessionKeyWriteLeaseState = {
  held: Map<string, SessionKeyWriteLeaseEntry>;
};

type AgentLeaseDatabase = Pick<OpenClawAgentKyselyDatabase, "state_leases">;
type SessionKeyWriteLeaseRow = {
  expires_at: number | null;
  owner: string;
  payload_json: string | null;
};

const sessionKeyWriteLeaseState = resolveGlobalSingleton(
  SESSION_KEY_WRITE_LEASE_STATE_KEY,
  (): SessionKeyWriteLeaseState => ({ held: new Map() }),
);

/**
 * Yield control to the event loop so other sessions can make progress
 * while lock contention callbacks run synchronous I/O.
 */
function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function stateLeaseDurationMs(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minimum, Math.floor(value)));
}

function sessionKeyLeasePath(sessionKey: string): string {
  return `sqlite:${SESSION_KEY_WRITE_LEASE_SCOPE}:${sessionKey}`;
}

export function resolveSessionWriteLockTargetKey(target: SessionTranscriptRuntimeTarget): string {
  const databaseTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  });
  const canonicalPath = canonicalizeSessionWriteLeaseDatabasePath(databaseTarget.path);
  return JSON.stringify([target.agentId, canonicalPath, target.sessionId]);
}

function canonicalizeSessionWriteLeaseDatabasePath(databasePath: string): string {
  const resolvedPath = path.resolve(databasePath);
  const missingSegments: string[] = [];
  let candidate = resolvedPath;
  while (true) {
    try {
      return path.join(fsSync.realpathSync(candidate), ...missingSegments.toReversed());
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return resolvedPath;
      }
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function resolveSessionKeyLeaseDatabaseOptions(sessionKey: string): OpenClawAgentDatabaseOptions {
  let agentId = resolveAgentIdFromSessionKey(sessionKey, LEGACY_IMPLICIT_AGENT_ID);
  let storePath: string | undefined;
  try {
    const parsed = JSON.parse(sessionKey) as unknown;
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [parsedAgentId, parsedStorePath, parsedSessionId] = parsed;
      if (
        typeof parsedAgentId === "string" &&
        parsedAgentId.trim().length > 0 &&
        typeof parsedStorePath === "string" &&
        parsedStorePath.trim().length > 0 &&
        typeof parsedSessionId === "string" &&
        parsedSessionId.trim().length > 0
      ) {
        agentId = parsedAgentId;
        storePath = parsedStorePath;
      }
    }
  } catch {
    // Unqualified compatibility keys use their agent's canonical database.
  }
  if (!storePath) {
    const database = openOpenClawAgentDatabase({ agentId });
    return { agentId, path: database.path };
  }
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  return { agentId: target.agentId ?? agentId, path: target.path };
}

function runSessionKeyLeaseWrite<T>(
  databaseOptions: OpenClawAgentDatabaseOptions,
  operation: (params: {
    db: ReturnType<typeof openOpenClawAgentDatabase>["db"];
    kysely: ReturnType<typeof getNodeSqliteKysely<AgentLeaseDatabase>>;
  }) => T,
): T {
  return runOpenClawAgentWriteTransaction(
    ({ db }) => operation({ db, kysely: getNodeSqliteKysely<AgentLeaseDatabase>(db) }),
    databaseOptions,
    { busyTimeoutMs: 0, operationLabel: "session.write-lease" },
  );
}

function readSessionKeyWriteLease(
  sessionKey: string,
  databaseOptions: OpenClawAgentDatabaseOptions,
): SessionKeyWriteLeaseRow | undefined {
  const database = openOpenClawAgentDatabase(databaseOptions);
  const kysely = getNodeSqliteKysely<AgentLeaseDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("state_leases")
      .select(["owner", "expires_at", "payload_json"])
      .where("scope", "=", SESSION_KEY_WRITE_LEASE_SCOPE)
      .where("lease_key", "=", sessionKey),
  );
}

function canReclaimSessionKeyWriteLease(current: SessionKeyWriteLeaseRow): boolean {
  let ownerPid: number | undefined;
  let ownerStarttime: number | undefined;
  try {
    const payload = current.payload_json
      ? (JSON.parse(current.payload_json) as { pid?: unknown; starttime?: unknown })
      : undefined;
    ownerPid = isValidLockNumber(payload?.pid) && payload.pid > 0 ? payload.pid : undefined;
    ownerStarttime = isValidLockNumber(payload?.starttime) ? payload.starttime : undefined;
  } catch {
    // Malformed rows are reclaimable only after their fixed deadline.
  }
  const ownerAlive = ownerPid ? isPidAlive(ownerPid) : undefined;
  const observedStarttime =
    ownerPid && ownerAlive ? resolveProcessStartTimeForLock(ownerPid) : null;
  const ownerReused =
    ownerStarttime !== undefined &&
    observedStarttime !== null &&
    ownerStarttime !== observedStarttime;
  // Never time-take over a demonstrably live owner without atomic fencing.
  // Cross-platform start-time identity handles PID reuse on supported hosts.
  return (
    ownerAlive === false || ownerReused || (!ownerPid && Number(current.expires_at) <= Date.now())
  );
}

function tryAcquireSessionKeyWriteLease(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  sessionKey: string;
  owner: string;
  maxHoldMs: number;
  processStarttime: number | null;
  observed: SessionKeyWriteLeaseRow | undefined;
  observedReclaimable: boolean;
}): boolean {
  return runSessionKeyLeaseWrite(params.databaseOptions, ({ db, kysely }) => {
    const now = Date.now();
    const current = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("state_leases")
        .select("owner")
        .where("scope", "=", SESSION_KEY_WRITE_LEASE_SCOPE)
        .where("lease_key", "=", params.sessionKey),
    );
    if (current) {
      if (
        !params.observed ||
        current.owner !== params.observed.owner ||
        !params.observedReclaimable
      ) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("state_leases")
          .where("scope", "=", SESSION_KEY_WRITE_LEASE_SCOPE)
          .where("lease_key", "=", params.sessionKey)
          .where("owner", "=", params.observed.owner),
      );
    }
    const inserted = executeSqliteQuerySync(
      db,
      kysely
        .insertInto("state_leases")
        .values({
          scope: SESSION_KEY_WRITE_LEASE_SCOPE,
          lease_key: params.sessionKey,
          owner: params.owner,
          expires_at: now + params.maxHoldMs,
          heartbeat_at: null,
          payload_json: JSON.stringify({
            pid: process.pid,
            ...(params.processStarttime === null ? {} : { starttime: params.processStarttime }),
            maxHoldMs: params.maxHoldMs,
          }),
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
    );
    return inserted.numAffectedRows === 1n;
  });
}

function releaseSessionKeyWriteLeaseOnce(
  sessionKey: string,
  owner: string,
  databaseOptions: OpenClawAgentDatabaseOptions,
): void {
  runSessionKeyLeaseWrite(databaseOptions, ({ db, kysely }) => {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("state_leases")
        .where("scope", "=", SESSION_KEY_WRITE_LEASE_SCOPE)
        .where("lease_key", "=", sessionKey)
        .where("owner", "=", owner),
    );
  });
}

async function releaseSessionKeyWriteLease(
  sessionKey: string,
  owner: string,
  databaseOptions: OpenClawAgentDatabaseOptions,
): Promise<void> {
  const deadline = performance.now() + SESSION_KEY_WRITE_LEASE_RELEASE_RETRY_MS;
  let attempt = 0;
  while (true) {
    try {
      releaseSessionKeyWriteLeaseOnce(sessionKey, owner, databaseOptions);
      return;
    } catch (error) {
      if (!isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      attempt += 1;
      await sleepWithAbort(
        Math.min(
          deadline - performance.now(),
          computeBackoff(SESSION_KEY_WRITE_LEASE_BACKOFF, attempt),
        ),
      );
    }
  }
}

function assertSessionKeyWriteLeaseOwned(
  sessionKey: string,
  owner: string,
  databaseOptions: OpenClawAgentDatabaseOptions,
): void {
  const current = sessionKeyWriteLeaseState.held.get(sessionKey);
  const database = openOpenClawAgentDatabase(databaseOptions);
  const kysely = getNodeSqliteKysely<AgentLeaseDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("state_leases")
      .select(["owner", "expires_at"])
      .where("scope", "=", SESSION_KEY_WRITE_LEASE_SCOPE)
      .where("lease_key", "=", sessionKey)
      .where("owner", "=", owner),
  );
  if (current?.owner === owner && row) {
    return;
  }
  throw new SessionWriteLockStaleError({
    owner: "expired or replaced SQLite lease",
    lockPath: sessionKeyLeasePath(sessionKey),
    staleReasons: ["lease-lost"],
  });
}

function createSessionKeyWriteLeaseHandle(
  sessionKey: string,
  entry: SessionKeyWriteLeaseEntry,
): { assertOwned: () => void; release: () => Promise<void> } {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  return {
    assertOwned: () =>
      assertSessionKeyWriteLeaseOwned(sessionKey, entry.owner, entry.databaseOptions),
    release: () => {
      if (released) {
        return Promise.resolve();
      }
      releasePromise ??= (async () => {
        const current = sessionKeyWriteLeaseState.held.get(sessionKey);
        if (current?.owner !== entry.owner) {
          return;
        }
        if (current.refCount > 1) {
          current.refCount -= 1;
          return;
        }
        sessionKeyWriteLeaseState.held.delete(sessionKey);
        try {
          await releaseSessionKeyWriteLease(sessionKey, entry.owner, entry.databaseOptions);
        } catch (error) {
          if (!sessionKeyWriteLeaseState.held.has(sessionKey)) {
            sessionKeyWriteLeaseState.held.set(sessionKey, current);
          }
          throw error;
        }
      })().then(
        () => {
          released = true;
        },
        (error: unknown) => {
          releasePromise = undefined;
          throw error;
        },
      );
      return releasePromise;
    },
  };
}

async function acquireSessionKeyWriteLease(params: {
  sessionKey: string;
  timeoutMs: number;
  maxHoldMs: number;
  allowReentrant: boolean;
  signal?: AbortSignal;
}): Promise<{ assertOwned: () => void; release: () => Promise<void> }> {
  const databaseOptions = resolveSessionKeyLeaseDatabaseOptions(params.sessionKey);
  const startedAtMs = performance.now();
  const owner = randomUUID();
  const maxHoldMs = stateLeaseDurationMs(params.maxHoldMs, 1);
  const processStarttime = resolveProcessStartTimeForLock(process.pid);
  let attempt = 0;
  while (true) {
    const existing = sessionKeyWriteLeaseState.held.get(params.sessionKey);
    if (params.allowReentrant && existing) {
      existing.refCount += 1;
      return createSessionKeyWriteLeaseHandle(params.sessionKey, existing);
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }
    let acquired = false;
    try {
      const observed = readSessionKeyWriteLease(params.sessionKey, databaseOptions);
      acquired = tryAcquireSessionKeyWriteLease({
        databaseOptions,
        sessionKey: params.sessionKey,
        owner,
        maxHoldMs,
        processStarttime,
        observed,
        observedReclaimable: observed ? canReclaimSessionKeyWriteLease(observed) : false,
      });
    } catch (error) {
      if (!isSqliteLockError(error)) {
        throw error;
      }
    }
    if (acquired) {
      const entry = { databaseOptions, owner, refCount: 1 };
      sessionKeyWriteLeaseState.held.set(params.sessionKey, entry);
      return createSessionKeyWriteLeaseHandle(params.sessionKey, entry);
    }
    const elapsedMs = performance.now() - startedAtMs;
    if (elapsedMs >= params.timeoutMs) {
      throw new SessionWriteLockTimeoutError({
        timeoutMs: params.timeoutMs,
        owner: "another OpenClaw process",
        lockPath: sessionKeyLeasePath(params.sessionKey),
      });
    }
    attempt += 1;
    const delayMs = Math.min(
      params.timeoutMs - elapsedMs,
      computeBackoff(SESSION_KEY_WRITE_LEASE_BACKOFF, attempt),
    );
    await sleepWithAbort(delayMs, params.signal);
  }
}
// A payload-less lock can be left behind during the window between open("wx")
// and the owner metadata write if the owner is suspended (CPU pressure,
// container freeze, I/O stall, GC pause). 30 s covers realistic system
// pauses while staying well below DEFAULT_TIMEOUT_GRACE_MS (120 s).
const ORPHAN_LOCK_PAYLOAD_GRACE_MS = 30_000;
const SHORT_TIMEOUT_ORPHAN_LOCK_PAYLOAD_GRACE_MS = 5_000;

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
const SESSION_LOCK_SWEEPS = createFileLockManager("openclaw.session-write-lock-sweep");

function isFileLockError(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

export type SessionWriteLockAcquireTimeoutConfig = OpenClawConfig;

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
  if (raw === "Infinity") {
    return opts.allowInfinity ? Number.POSITIVE_INFINITY : undefined;
  }
  if (!/^\d+$/.test(raw)) {
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
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

function resolveSessionWriteLockMs(params: {
  env?: NodeJS.ProcessEnv;
  key: SessionWriteLockMsKey;
  fallback: number;
  allowInfinity?: boolean;
}): number {
  const opts = { allowInfinity: params.allowInfinity };
  return (
    readPositiveMsEnv(params.env ?? process.env, SESSION_WRITE_LOCK_ENV[params.key], opts) ??
    params.fallback
  );
}

export function resolveSessionWriteLockAcquireTimeoutMs(
  _config?: SessionWriteLockAcquireTimeoutConfig,
  env?: NodeJS.ProcessEnv,
): number {
  return resolveSessionWriteLockMs({
    env,
    key: "acquireTimeoutMs",
    fallback: DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS,
    allowInfinity: true,
  });
}

export function resolveSessionWriteLockStaleMs(
  _config?: SessionWriteLockAcquireTimeoutConfig,
  env?: NodeJS.ProcessEnv,
): number {
  return resolveSessionWriteLockMs({
    env,
    key: "staleMs",
    fallback: DEFAULT_SESSION_WRITE_LOCK_STALE_MS,
  });
}

function resolveSessionWriteLockMaxHoldMs(
  _config?: SessionWriteLockAcquireTimeoutConfig,
  params: { env?: NodeJS.ProcessEnv; fallback?: number } = {},
): number {
  return resolveSessionWriteLockMs({
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
    return MAX_TIMER_TIMEOUT_MS;
  }
  const graceMs = resolvePositiveMs(params.graceMs, DEFAULT_TIMEOUT_GRACE_MS);
  return Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minMs, timeoutMs + graceMs));
}

/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
function releaseAllLocksSync(options?: { preserveSessionLeases?: boolean }): void {
  SESSION_LOCKS.reset();
  if (!options?.preserveSessionLeases) {
    for (const [sessionKey, entry] of sessionKeyWriteLeaseState.held) {
      try {
        releaseSessionKeyWriteLeaseOnce(sessionKey, entry.owner, entry.databaseOptions);
      } catch {
        // Fixed expiry still recovers the row after an exit-time SQLite failure.
      }
    }
    sessionKeyWriteLeaseState.held.clear();
  }
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

    console.warn(
      `[session-write-lock] releasing lock held for ${heldForMs}ms (max=${maxHoldMs}ms): ${held.lockPath}`,
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
  return process.env.VITEST !== "true";
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
  const shouldReraise = process.listenerCount(signal) === 1;
  // A graceful gateway handler must drain in-flight transcript writes before
  // releasing their SQLite leases; legacy file locks remain signal-immediate.
  releaseAllLocksSync({ preserveSessionLeases: !shouldReraise });
  const cleanupState = resolveCleanupState();
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

function parseLockPayload(raw: string): LockFilePayload | null {
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
  if (isValidLockNumber(parsed.maxHoldMs) && parsed.maxHoldMs > 0) {
    payload.maxHoldMs = parsed.maxHoldMs;
  }
  return payload;
}

function parseLockPayloadOrNull(raw: string): LockFilePayload | null {
  try {
    return parseLockPayload(raw);
  } catch {
    return null;
  }
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return parseLockPayload(raw);
  } catch {
    return null;
  }
}

async function readLockPayloadForDiagnostics(
  lockPath: string,
): Promise<{ payload: LockFilePayload | null; missing: boolean }> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return { payload: parseLockPayload(raw), missing: false };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return { payload: null, missing: code === "ENOENT" };
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

function resolveSessionWriteLockTarget(sessionFile: string): string {
  return path.resolve(sessionFile);
}

function normalizeOwnerProcessArg(arg: string): string {
  return arg.trim().replaceAll("\\", "/").toLowerCase();
}

function isOpenClawSessionOwnerArgv(args: string[]): boolean {
  if (isGatewayArgv(args, { allowGatewayBinary: true })) {
    return true;
  }
  const normalized = args.map(normalizeOwnerProcessArg).filter(Boolean);
  if (normalized.length === 0) {
    return false;
  }
  const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  if (exe === "openclaw" || exe.endsWith("/openclaw")) {
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
  const hasAgentCommandToken = normalized.includes("agent");
  return normalized.some(
    (arg) => entryCandidates.some((entry) => arg.endsWith(entry)) && hasAgentCommandToken,
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
  opts: { respectMaxHold?: boolean } = {},
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
  const holderMaxHoldMs =
    isValidLockNumber(payload?.maxHoldMs) && payload.maxHoldMs > 0 ? payload.maxHoldMs : undefined;
  if (
    opts.respectMaxHold === true &&
    typeof holderMaxHoldMs === "number" &&
    ageMs !== null &&
    ageMs > holderMaxHoldMs
  ) {
    staleReasons.push("hold-exceeded");
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
  if (params.inspected.pid === null || !params.inspected.pidAlive) {
    return false;
  }
  if (params.inspected.staleReasons.includes("recycled-pid")) {
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

async function shouldReportContendedLockStale(params: {
  lockPath: string;
  details: LockInspectionDetails;
  heldByThisProcess: boolean;
  staleMs: number;
  nowMs: number;
  orphanPayloadGraceMs: number;
}): Promise<boolean> {
  if (!params.details.stale) {
    return false;
  }
  if (params.heldByThisProcess) {
    return false;
  }
  if (lockInspectionNeedsMtimeStaleFallback(params.details)) {
    try {
      const stat = await fs.stat(params.lockPath);
      const ageMs = Math.max(0, params.nowMs - stat.mtimeMs);
      return ageMs > Math.min(params.staleMs, params.orphanPayloadGraceMs);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      return code !== "ENOENT";
    }
  }
  return true;
}

async function shouldRemoveContendedLockFile(
  lockPath: string,
  details: LockInspectionDetails,
  staleMs: number,
  nowMs: number,
  orphanPayloadGraceMs = ORPHAN_LOCK_PAYLOAD_GRACE_MS,
): Promise<boolean> {
  if (!details.stale) {
    return false;
  }
  if (details.staleReasons.every((reason) => REPORT_ONLY_STALE_LOCK_REASONS.has(reason))) {
    return false;
  }
  if (!lockInspectionNeedsMtimeStaleFallback(details)) {
    return true;
  }
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Math.max(0, nowMs - stat.mtimeMs);
    return ageMs > Math.min(staleMs, orphanPayloadGraceMs);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return code !== "ENOENT";
  }
}

function resolveOrphanLockPayloadGraceMs(timeoutMs: number): number {
  if (timeoutMs < ORPHAN_LOCK_PAYLOAD_GRACE_MS) {
    return SHORT_TIMEOUT_ORPHAN_LOCK_PAYLOAD_GRACE_MS;
  }
  return ORPHAN_LOCK_PAYLOAD_GRACE_MS;
}

function resolveRemainingAcquireTimeoutMs(
  timeoutMs: number,
  startedAtMs: number,
  nowMs: number,
): number {
  if (timeoutMs === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  return Math.max(0, timeoutMs - elapsedMs);
}

async function shouldRetryStaleAcquireFailure(params: {
  lockPath: string;
  lockMissingAtDiagnostics: boolean;
  inspected: LockInspectionDetails;
  heldByThisProcess: boolean;
  staleMs: number;
  nowMs: number;
  orphanPayloadGraceMs: number;
}): Promise<boolean> {
  if (params.lockMissingAtDiagnostics) {
    return true;
  }
  return !(await shouldReportContendedLockStale({
    lockPath: params.lockPath,
    details: params.inspected,
    heldByThisProcess: params.heldByThisProcess,
    staleMs: params.staleMs,
    nowMs: params.nowMs,
    orphanPayloadGraceMs: params.orphanPayloadGraceMs,
  }));
}

async function reclaimSessionLockIfUnchanged(
  lockPath: string,
  staleMs: number,
  nowMs: number,
  ownerProcessArgsReader: SessionLockOwnerProcessArgsReader,
): Promise<boolean> {
  const shouldReclaim = async (payload: LockFilePayload | null) => {
    const inspected = inspectLockPayloadForSession({
      payload,
      staleMs,
      nowMs,
      heldByThisProcess: false,
      reclaimLockWithoutStarttime: false,
      readOwnerProcessArgs: ownerProcessArgsReader,
    });
    return (
      inspected.stale && (await shouldRemoveContendedLockFile(lockPath, inspected, staleMs, nowMs))
    );
  };
  try {
    const lock = await SESSION_LOCK_SWEEPS.acquire(lockPath, {
      lockPath,
      staleMs,
      timeoutMs: 0,
      retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged",
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      parsePayload: parseLockPayloadOrNull,
      shouldReclaim: ({ payload }) => shouldReclaim(payload as LockFilePayload | null),
      shouldRemoveStaleLock: ({ payload }) => shouldReclaim(payload as LockFilePayload | null),
    });
    await lock.release();
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "file_lock_timeout" || code === "file_lock_stale") {
      return false;
    }
    throw error;
  }
}

function sessionLockHeldByThisProcess(normalizedSessionFile: string): boolean {
  return SESSION_LOCKS.heldEntries().some(
    (entry) => entry.normalizedTargetPath === normalizedSessionFile,
  );
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

function describeLockOwnerForError(params: {
  payload: LockFilePayload | null;
  inspected: LockInspectionDetails;
}): string {
  const parts: string[] = [];
  if (params.inspected.pid !== null) {
    parts.push(`pid=${params.inspected.pid}`);
    parts.push(`alive=${params.inspected.pidAlive ? "true" : "false"}`);
  } else if (typeof params.payload?.pid === "number") {
    parts.push(`pid=${params.payload.pid}`);
  } else {
    parts.push("owner=unknown");
  }
  if (typeof params.inspected.ageMs === "number") {
    parts.push(`ageMs=${Math.floor(params.inspected.ageMs)}`);
  }
  return parts.join(" ");
}

function inspectLockPayloadForSession(params: {
  payload: LockFilePayload | null;
  staleMs: number;
  nowMs: number;
  heldByThisProcess: boolean;
  reclaimLockWithoutStarttime: boolean;
  readOwnerProcessArgs: SessionLockOwnerProcessArgsReader;
  respectMaxHold?: boolean;
}): LockInspectionDetails {
  const inspected = inspectLockPayload(params.payload, params.staleMs, params.nowMs, {
    respectMaxHold: params.respectMaxHold,
  });
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
  const baseOwnerProcessArgsReader = params.readOwnerProcessArgs ?? readProcessArgsSync;
  // Memoize per-invocation: many locks in the same sweep often share a pid (gateway, MCP),
  // and resolving owner argv is the most expensive per-lock syscall (PowerShell on Windows
  // is ~0.5–1s per pid) — pids do not recycle within a single sweep. (#86509)
  const ownerArgsByPid = new Map<number, string[] | null>();
  const ownerProcessArgsReader: SessionLockOwnerProcessArgsReader = (pid) => {
    const cached = ownerArgsByPid.get(pid);
    if (cached !== undefined) {
      return cached;
    }
    const args = baseOwnerProcessArgsReader(pid);
    ownerArgsByPid.set(pid, args);
    return args;
  };

  let entries: fsSync.Dirent[];
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
    // Yield to the event loop between locks so concurrent timers/HTTP polling can run
    // while this sweep does per-lock sync syscalls (isPidAlive, /proc reads, PowerShell). (#86509)
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
    const removable =
      inspected.stale && (await shouldRemoveContendedLockFile(lockPath, inspected, staleMs, nowMs));
    const lockInfo: SessionLockInspection = {
      lockPath,
      ...inspected,
      removable,
      removed: false,
    };

    if (removeStale && removable) {
      lockInfo.removed = await reclaimSessionLockIfUnchanged(
        lockPath,
        staleMs,
        nowMs,
        ownerProcessArgsReader,
      );
      if (lockInfo.removed) {
        cleaned.push(lockInfo);
        params.log?.warn?.(
          `removed stale session lock: ${lockPath} (${lockInfo.staleReasons.join(", ") || "unknown"})`,
        );
      }
    }

    locks.push(lockInfo);
  }

  return { locks, cleaned };
}

type AcquireSessionWriteLockBaseParams = {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  signal?: AbortSignal;
};

type AcquireSessionWriteLockParams = AcquireSessionWriteLockBaseParams &
  (
    | {
        targetKind: "session-key";
        /** Reuse the process-local SQLite lease held for this session key. */
        allowReentrant?: boolean;
        reentrantOwner?: never;
      }
    | {
        targetKind?: "file";
        /** Process-local identity for intentional nesting on retained file-lock targets. */
        reentrantOwner?: string;
        allowReentrant?: never;
      }
  );

export async function acquireSessionWriteLock(params: AcquireSessionWriteLockParams): Promise<{
  assertOwned?: () => void;
  release: () => Promise<void>;
}> {
  const throwIfAborted = () => {
    if (!params.signal?.aborted) {
      return;
    }
    if (params.signal.reason instanceof Error) {
      throw params.signal.reason;
    }
    const error = new Error("request aborted", { cause: params.signal.reason });
    error.name = "AbortError";
    throw error;
  };
  throwIfAborted();
  const defaultOptions = resolveSessionWriteLockOptions();
  const timeoutMs = resolvePositiveMs(params.timeoutMs, defaultOptions.timeoutMs, {
    allowInfinity: true,
  });
  const staleMs = resolvePositiveMs(params.staleMs, defaultOptions.staleMs);
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, defaultOptions.maxHoldMs);
  registerCleanupHandlers();
  if (params.targetKind === "session-key") {
    return await acquireSessionKeyWriteLease({
      sessionKey: params.sessionFile,
      timeoutMs,
      maxHoldMs,
      allowReentrant: params.allowReentrant ?? false,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }
  const orphanPayloadGraceMs = resolveOrphanLockPayloadGraceMs(timeoutMs);
  const sessionFile = resolveSessionWriteLockTarget(params.sessionFile);
  const sessionDir = path.dirname(sessionFile);
  const normalizedSessionFile = await resolveNormalizedSessionFile(sessionFile);
  const lockPath = `${normalizedSessionFile}.lock`;
  await fs.mkdir(sessionDir, { recursive: true });
  const startedAtMs = Date.now();

  while (true) {
    throwIfAborted();
    const remainingTimeoutMs = resolveRemainingAcquireTimeoutMs(timeoutMs, startedAtMs, Date.now());
    if (remainingTimeoutMs <= 0) {
      const payload = await readLockPayload(lockPath);
      const nowMs = Date.now();
      const heldByThisProcess = sessionLockHeldByThisProcess(normalizedSessionFile);
      const inspected = inspectLockPayloadForSession({
        payload,
        staleMs,
        nowMs,
        heldByThisProcess,
        reclaimLockWithoutStarttime: true,
        readOwnerProcessArgs: readProcessArgsSync,
        respectMaxHold: !heldByThisProcess,
      });
      const owner = describeLockOwnerForError({ payload, inspected });
      throw new SessionWriteLockTimeoutError({ timeoutMs, owner, lockPath });
    }
    try {
      const acquireAttemptTimeoutMs = params.signal
        ? Math.min(remainingTimeoutMs, ABORTABLE_SESSION_WRITE_LOCK_POLL_MS)
        : remainingTimeoutMs;
      const lock = await SESSION_LOCKS.acquire(sessionFile, {
        staleMs,
        timeoutMs: acquireAttemptTimeoutMs,
        retry: { minTimeout: 50, maxTimeout: 1000, factor: 1 },
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: params.reentrantOwner,
        metadata: { maxHoldMs },
        payload: () => {
          const createdAt = new Date().toISOString();
          const starttime = resolveProcessStartTimeForLock(process.pid);
          const lockPayload: LockFilePayload = { pid: process.pid, createdAt, maxHoldMs };
          if (starttime !== null) {
            lockPayload.starttime = starttime;
          }
          return lockPayload as Record<string, unknown>;
        },
        shouldReclaim: async ({ payload, nowMs, heldByThisProcess }) => {
          // Yield to the event loop before synchronous process inspection
          // to prevent lock contention retries from starving other sessions.
          await yieldEventLoop();
          const inspected = inspectLockPayloadForSession({
            payload: payload as LockFilePayload | null,
            staleMs,
            nowMs,
            heldByThisProcess,
            reclaimLockWithoutStarttime: true,
            readOwnerProcessArgs: readProcessArgsSync,
            respectMaxHold: !heldByThisProcess,
          });
          return await shouldReportContendedLockStale({
            lockPath,
            details: inspected,
            heldByThisProcess,
            staleMs,
            nowMs,
            orphanPayloadGraceMs,
          });
        },
        shouldRemoveStaleLock: async ({
          lockPath: lockPathLocal,
          normalizedTargetPath,
          payload,
        }) => {
          await yieldEventLoop();
          const nowMs = Date.now();
          const heldByThisProcess = sessionLockHeldByThisProcess(normalizedTargetPath);
          const inspected = inspectLockPayloadForSession({
            payload: payload as LockFilePayload | null,
            staleMs,
            nowMs,
            heldByThisProcess,
            reclaimLockWithoutStarttime: true,
            readOwnerProcessArgs: readProcessArgsSync,
            respectMaxHold: !heldByThisProcess,
          });
          return await shouldRemoveContendedLockFile(
            lockPathLocal,
            inspected,
            staleMs,
            nowMs,
            orphanPayloadGraceMs,
          );
        },
      });
      return { release: lock.release };
    } catch (err) {
      throwIfAborted();
      if (!isFileLockError(err, "file_lock_timeout") && !isFileLockError(err, "file_lock_stale")) {
        throw err;
      }
      if (
        params.signal &&
        isFileLockError(err, "file_lock_timeout") &&
        resolveRemainingAcquireTimeoutMs(timeoutMs, startedAtMs, Date.now()) > 0
      ) {
        continue;
      }
      const errorLockPath = (err as { lockPath?: string }).lockPath ?? lockPath;
      const { payload, missing: lockMissingAtDiagnostics } =
        await readLockPayloadForDiagnostics(errorLockPath);
      const nowMs = Date.now();
      const heldByThisProcess = sessionLockHeldByThisProcess(normalizedSessionFile);
      const inspected = inspectLockPayloadForSession({
        payload,
        staleMs,
        nowMs,
        heldByThisProcess,
        reclaimLockWithoutStarttime: true,
        readOwnerProcessArgs: readProcessArgsSync,
        respectMaxHold: !heldByThisProcess,
      });
      const owner = describeLockOwnerForError({ payload, inspected });
      if (isFileLockError(err, "file_lock_stale")) {
        if (
          resolveRemainingAcquireTimeoutMs(timeoutMs, startedAtMs, Date.now()) > 0 &&
          (await shouldRetryStaleAcquireFailure({
            lockPath: errorLockPath,
            lockMissingAtDiagnostics,
            inspected,
            heldByThisProcess,
            staleMs,
            nowMs,
            orphanPayloadGraceMs,
          }))
        ) {
          continue;
        }
        throw new SessionWriteLockStaleError({
          owner,
          lockPath: errorLockPath,
          staleReasons: inspected.staleReasons,
        });
      }
      throw new SessionWriteLockTimeoutError({ timeoutMs, owner, lockPath: errorLockPath });
    }
  }
}

const testing = {
  cleanupSignals: [...CLEANUP_SIGNALS],
  handleTerminationSignal,
  inspectLockPayloadForTest: inspectLockPayload,
  releaseAllLocksSync,
  runLockWatchdogCheck,
  resolveRemainingAcquireTimeoutMs,
  setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void {
    resolveProcessStartTimeForLock = resolver ?? defaultProcessStartTimeForLock;
  },
};

export async function drainSessionWriteLockStateForTest(): Promise<void> {
  await SESSION_LOCKS.drain();
  stopWatchdogTimer();
  unregisterCleanupHandlers();
}

function resetSessionWriteLockStateForTest(): void {
  releaseAllLocksSync();
  stopWatchdogTimer();
  unregisterCleanupHandlers();
  resolveProcessStartTimeForLock = defaultProcessStartTimeForLock;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionWriteLockTestApi")] = {
    resetSessionWriteLockStateForTest,
    testing,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
