import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-port-pids.js";
import { LEGACY_IMPLICIT_AGENT_ID, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import {
  acquireOpenClawStateLease,
  OpenClawStateLeaseError,
  type OpenClawStateLeaseHandle,
} from "../state/openclaw-state-lease.js";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "./session-write-lock-error.js";

const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_GRACE_MS = 2 * 60 * 1000;
const SESSION_WRITE_LEASE_SCOPE = "session-write";
const SESSION_WRITE_LEASE_STATE_KEY = Symbol.for("openclaw.sessionWriteLeaseState");

const defaultProcessStartTimeForLock = (pid: number): number | null =>
  process.platform === "win32"
    ? readWindowsProcessStartTimeSync(pid, 1_000)
    : getFileLockProcessStartTime(pid);
let resolveProcessStartTimeForLock = defaultProcessStartTimeForLock;

type SessionWriteLeaseEntry = {
  lease: OpenClawStateLeaseHandle;
  refCount: number;
};

const sessionWriteLeaseState = resolveGlobalSingleton(
  SESSION_WRITE_LEASE_STATE_KEY,
  (): { held: Map<string, SessionWriteLeaseEntry> } => ({ held: new Map() }),
);

export type SessionWriteLockAcquireTimeoutConfig = OpenClawConfig;

type SessionWriteLockMsKey = "acquireTimeoutMs" | "staleMs" | "maxHoldMs";

const SESSION_WRITE_LOCK_ENV: Record<SessionWriteLockMsKey, string> = {
  acquireTimeoutMs: "OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS",
  staleMs: "OPENCLAW_SESSION_WRITE_LOCK_STALE_MS",
  maxHoldMs: "OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS",
};

function parsePositiveMs(
  value: number | undefined,
  options: { allowInfinity?: boolean } = {},
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return undefined;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return options.allowInfinity ? value : undefined;
  }
  return Number.isSafeInteger(value) ? value : undefined;
}

function resolvePositiveMs(
  value: number | undefined,
  fallback: number,
  options: { allowInfinity?: boolean } = {},
): number {
  if (value === Number.POSITIVE_INFINITY) {
    return options.allowInfinity ? value : fallback;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveMsEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  options: { allowInfinity?: boolean } = {},
): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw === "Infinity") {
    return options.allowInfinity ? Number.POSITIVE_INFINITY : undefined;
  }
  return /^\d+$/.test(raw) ? parsePositiveMs(Number(raw), options) : undefined;
}

function resolveSessionWriteLockMs(params: {
  env?: NodeJS.ProcessEnv;
  key: SessionWriteLockMsKey;
  fallback: number;
  allowInfinity?: boolean;
}): number {
  return (
    readPositiveMsEnv(params.env ?? process.env, SESSION_WRITE_LOCK_ENV[params.key], {
      allowInfinity: params.allowInfinity,
    }) ?? params.fallback
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

export function resolveSessionWriteLockTargetKey(target: SessionTranscriptRuntimeTarget): string {
  const databaseTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  });
  return JSON.stringify([
    target.agentId,
    resolvePathViaExistingAncestorSync(databaseTarget.path),
    target.sessionId,
  ]);
}

function resolveSessionWriteLeaseDatabaseOptions(sessionKey: string): OpenClawAgentDatabaseOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionKey) as unknown;
  } catch {
    // Shipped unqualified harness keys use their agent's canonical database.
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 3 &&
    parsed.every((value) => typeof value === "string" && value.trim().length > 0)
  ) {
    const [agentId, storePath] = parsed as [string, string, string];
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
    return { agentId: target.agentId ?? agentId, path: target.path };
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey, LEGACY_IMPLICIT_AGENT_ID);
  return { agentId, path: openOpenClawAgentDatabase({ agentId }).path };
}

function leaseDurationMs(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minimum, Math.floor(value)));
}

function leasePath(sessionKey: string): string {
  return `sqlite:${SESSION_WRITE_LEASE_SCOPE}:${sessionKey}`;
}

function leaseLost(sessionKey: string): SessionWriteLockStaleError {
  return new SessionWriteLockStaleError({
    owner: "expired or replaced SQLite lease",
    lockPath: leasePath(sessionKey),
    staleReasons: ["lease-lost"],
  });
}

function createLeaseHandle(sessionKey: string, entry: SessionWriteLeaseEntry) {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  return {
    assertOwned: () => {
      if (sessionWriteLeaseState.held.get(sessionKey) !== entry) {
        throw leaseLost(sessionKey);
      }
      try {
        entry.lease.assertOwned();
      } catch (error) {
        if (
          error instanceof OpenClawStateLeaseError &&
          error.code === "OPENCLAW_STATE_LEASE_LOST"
        ) {
          throw leaseLost(sessionKey);
        }
        throw error;
      }
    },
    release: () => {
      if (released) {
        return Promise.resolve();
      }
      releasePromise ??= (async () => {
        const current = sessionWriteLeaseState.held.get(sessionKey);
        if (current !== entry) {
          return;
        }
        if (current.refCount > 1) {
          current.refCount -= 1;
          return;
        }
        sessionWriteLeaseState.held.delete(sessionKey);
        try {
          await current.lease.release();
        } catch (error) {
          if (!sessionWriteLeaseState.held.has(sessionKey)) {
            sessionWriteLeaseState.held.set(sessionKey, current);
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

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  targetKind: "session-key";
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  signal?: AbortSignal;
  allowReentrant?: boolean;
  reentrantOwner?: never;
}): Promise<{ assertOwned?: () => void; release: () => Promise<void> }> {
  if (params.signal?.aborted) {
    throw params.signal.reason;
  }
  const defaults = resolveSessionWriteLockOptions();
  const timeoutMs = resolvePositiveMs(params.timeoutMs, defaults.timeoutMs, {
    allowInfinity: true,
  });
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, defaults.maxHoldMs);
  const existing = sessionWriteLeaseState.held.get(params.sessionFile);
  if (params.allowReentrant === true && existing) {
    existing.refCount += 1;
    return createLeaseHandle(params.sessionFile, existing);
  }

  const databaseOptions = resolveSessionWriteLeaseDatabaseOptions(params.sessionFile);
  openOpenClawAgentDatabase(databaseOptions);
  const admission = new AbortController();
  const abortAdmission = () => admission.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abortAdmission, { once: true });
  try {
    const lease = await acquireOpenClawStateLease({
      scope: SESSION_WRITE_LEASE_SCOPE,
      key: params.sessionFile,
      database: {
        scope: "agent",
        agentId: databaseOptions.agentId,
        ...(databaseOptions.path ? { path: databaseOptions.path } : {}),
      },
      leaseMs: leaseDurationMs(maxHoldMs, 1_000),
      waitMs: leaseDurationMs(timeoutMs, 0),
      signal: admission.signal,
      leaseLabel: "session write lease",
      operationLabel: "session.write-lease",
      strictRelease: true,
      processOwner: {
        pid: process.pid,
        startTime: resolveProcessStartTimeForLock(process.pid),
        isAlive: isPidAlive,
        readStartTime: resolveProcessStartTimeForLock,
      },
    });
    params.signal?.removeEventListener("abort", abortAdmission);
    const entry = { lease, refCount: 1 };
    sessionWriteLeaseState.held.set(params.sessionFile, entry);
    return createLeaseHandle(params.sessionFile, entry);
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }
    if (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_TIMEOUT") {
      throw new SessionWriteLockTimeoutError({
        timeoutMs,
        owner: "another OpenClaw process",
        lockPath: leasePath(params.sessionFile),
      });
    }
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", abortAdmission);
  }
}

function releaseAllSessionWriteLeasesSynchronously(): void {
  for (const entry of sessionWriteLeaseState.held.values()) {
    try {
      entry.lease.releaseSynchronously();
    } catch {
      // A dead process owner remains reclaimable by pid/start-time identity.
    }
  }
  sessionWriteLeaseState.held.clear();
}

export async function drainSessionWriteLockStateForTest(): Promise<void> {
  const held = [...sessionWriteLeaseState.held.values()];
  sessionWriteLeaseState.held.clear();
  await Promise.all(held.map((entry) => entry.lease.release().catch(() => undefined)));
}

function resetSessionWriteLockStateForTest(): void {
  releaseAllSessionWriteLeasesSynchronously();
  resolveProcessStartTimeForLock = defaultProcessStartTimeForLock;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionWriteLockTestApi")] = {
    resetSessionWriteLockStateForTest,
    testing: {
      releaseAllLocksSync: releaseAllSessionWriteLeasesSynchronously,
      setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void {
        resolveProcessStartTimeForLock = resolver ?? defaultProcessStartTimeForLock;
      },
    },
  };
}
