import "../infra/fs-safe-defaults.js";
import fs from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "../agents/session-write-lock-error.js";
import {
  acquireSessionWriteLock as acquireSqliteSessionWriteLock,
  resolveSessionWriteLockAcquireTimeoutMs,
  resolveSessionWriteLockOptions,
  type SessionWriteLockAcquireTimeoutConfig,
} from "../agents/session-write-lock.js";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import {
  inspectSessionLockFileContention,
  parseSessionLockFilePayload,
  readSessionLockProcessStartTime,
  type SessionLockFilePayload,
} from "../infra/session-lock-file-inspection.js";
import { isPidAlive } from "../shared/pid-alive.js";

export {
  resolveSessionWriteLockAcquireTimeoutMs,
  resolveSessionWriteLockOptions,
  type SessionWriteLockAcquireTimeoutConfig,
};

type LockParams = {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  signal?: AbortSignal;
} & (
  | { targetKind: "session-key"; allowReentrant?: boolean; reentrantOwner?: never }
  | { targetKind?: "file"; reentrantOwner?: string; allowReentrant?: never }
);

const FILE_LOCKS = createFileLockManager("openclaw.session-write-lock.sdk-compat");
const ABORT_POLL_MS = 100;
const WATCHDOG_INTERVAL_MS = 60_000;
const ORPHAN_GRACE_MS = 30_000;
const SHORT_ORPHAN_GRACE_MS = 5_000;
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
const signalCleanup = new Map<NodeJS.Signals, () => void>();
let watchdog: NodeJS.Timeout | undefined;

function positiveMs(value: number | undefined, fallback: number, allowInfinity = false): number {
  if (value === Number.POSITIVE_INFINITY) {
    return allowInfinity ? value : fallback;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function readOwner(lockPath: string, staleMs: number, orphanGraceMs: number) {
  let payload: SessionLockFilePayload | null = null;
  let missing = false;
  try {
    payload = parseSessionLockFilePayload(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    // The lock can disappear between acquisition failure and diagnostics.
  }
  const { inspection, report } = await inspectSessionLockFileContention({
    lockPath,
    payload,
    staleMs,
    nowMs: Date.now(),
    orphanGraceMs,
    reclaimLockWithoutStarttime: true,
    respectMaxHold: true,
  });
  const { pid } = inspection;
  return {
    missing,
    pid,
    owner: pid === null ? "owner=unknown" : `pid=${pid} alive=${isPidAlive(pid)}`,
    reasons: report ? inspection.staleReasons : [],
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("request aborted", { cause: signal.reason });
  error.name = "AbortError";
  throw error;
}

function ensureSignalCleanup(): void {
  if (signalCleanup.size > 0) {
    return;
  }
  for (const signal of CLEANUP_SIGNALS) {
    const listener = () => {
      const reraise = process.listenerCount(signal) === 1;
      FILE_LOCKS.reset();
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
      if (reraise) {
        process.off(signal, listener);
        signalCleanup.delete(signal);
        try {
          process.kill(process.pid, signal);
        } catch {}
      }
    };
    try {
      process.on(signal, listener);
      signalCleanup.set(signal, listener);
    } catch {}
  }
}

function ensureWatchdog(): void {
  if (watchdog || process.env.VITEST === "true") {
    return;
  }
  watchdog = setInterval(() => {
    const now = Date.now();
    for (const held of FILE_LOCKS.heldEntries()) {
      const maxHoldMs = Number(held.metadata.maxHoldMs);
      if (Number.isFinite(maxHoldMs) && now - held.acquiredAt > maxHoldMs) {
        console.warn(
          `[session-write-lock] releasing lock held for ${now - held.acquiredAt}ms (max=${maxHoldMs}ms): ${held.lockPath}`,
        );
        void held.forceRelease().catch(() => undefined);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
}

async function acquireFileArtifactLock(
  params: LockParams & { targetKind?: "file" },
): Promise<{ release: () => Promise<void> }> {
  throwIfAborted(params.signal);
  ensureSignalCleanup();
  ensureWatchdog();
  const defaults = resolveSessionWriteLockOptions();
  const timeoutMs = positiveMs(params.timeoutMs, defaults.timeoutMs, true);
  const staleMs = positiveMs(params.staleMs, defaults.staleMs);
  const maxHoldMs = positiveMs(params.maxHoldMs, defaults.maxHoldMs);
  const orphanGraceMs = timeoutMs < ORPHAN_GRACE_MS ? SHORT_ORPHAN_GRACE_MS : ORPHAN_GRACE_MS;
  const targetPath = path.resolve(params.sessionFile);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const startedAt = Date.now();
  const inspectArtifact = async (
    lockPath: string,
    payload: unknown,
    nowMs: number,
    heldByThisProcess = false,
  ) => {
    await scheduler.yield();
    return await inspectSessionLockFileContention({
      lockPath,
      payload: payload as SessionLockFilePayload | null,
      staleMs,
      nowMs,
      orphanGraceMs,
      heldByThisProcess,
      reclaimLockWithoutStarttime: true,
      respectMaxHold: true,
    });
  };
  while (true) {
    throwIfAborted(params.signal);
    const remainingMs =
      timeoutMs === Number.POSITIVE_INFINITY
        ? timeoutMs
        : Math.max(0, timeoutMs - (Date.now() - startedAt));
    const lockPath = `${targetPath}.lock`;
    if (remainingMs <= 0) {
      const diagnostics = await readOwner(lockPath, staleMs, orphanGraceMs);
      throw new SessionWriteLockTimeoutError({ timeoutMs, owner: diagnostics.owner, lockPath });
    }
    try {
      const lock = await FILE_LOCKS.acquire(targetPath, {
        staleMs,
        timeoutMs: params.signal ? Math.min(remainingMs, ABORT_POLL_MS) : remainingMs,
        retry: { minTimeout: 50, maxTimeout: 1_000, factor: 1 },
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: params.reentrantOwner,
        metadata: { maxHoldMs },
        payload: () => {
          const starttime = readSessionLockProcessStartTime(process.pid);
          return {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            maxHoldMs,
            ...(starttime === null ? {} : { starttime }),
          };
        },
        parsePayload: parseSessionLockFilePayload,
        shouldReclaim: async ({ lockPath: contenderPath, payload, nowMs, heldByThisProcess }) =>
          (await inspectArtifact(contenderPath, payload, nowMs, heldByThisProcess)).report,
        shouldRemoveStaleLock: async ({ lockPath: contenderPath, payload }) =>
          (await inspectArtifact(contenderPath, payload, Date.now())).removable,
      });
      // The signal can fire while fs-safe owns its retry loop. Never return a
      // newly acquired sidecar after the caller has cancelled admission.
      if (params.signal?.aborted) {
        await lock.release().catch(() => undefined);
        throwIfAborted(params.signal);
      }
      return { release: () => lock.release() };
    } catch (error) {
      throwIfAborted(params.signal);
      const code = (error as NodeJS.ErrnoException).code;
      if (params.signal && code === "file_lock_timeout" && remainingMs > ABORT_POLL_MS) {
        continue;
      }
      const errorLockPath = (error as { lockPath?: string }).lockPath ?? `${targetPath}.lock`;
      const diagnostics = await readOwner(errorLockPath, staleMs, orphanGraceMs);
      if (code === "file_lock_stale") {
        if (diagnostics.missing || diagnostics.reasons.length === 0) {
          continue;
        }
        throw new SessionWriteLockStaleError({
          owner: diagnostics.owner,
          lockPath: errorLockPath,
          staleReasons: diagnostics.reasons,
        });
      }
      if (code === "file_lock_timeout") {
        if (
          diagnostics.pid !== process.pid &&
          diagnostics.reasons.some((reason) => reason === "too-old" || reason === "hold-exceeded")
        ) {
          throw new SessionWriteLockStaleError({
            owner: diagnostics.owner,
            lockPath: errorLockPath,
            staleReasons: diagnostics.reasons,
          });
        }
        throw new SessionWriteLockTimeoutError({
          timeoutMs,
          owner: diagnostics.owner,
          lockPath: errorLockPath,
        });
      }
      throw error;
    }
  }
}

/** Acquires the shipped file-artifact lock or the canonical SQLite session lease. */
export async function acquireSessionWriteLock(
  params: LockParams,
): Promise<{ assertOwned?: () => void; release: () => Promise<void> }> {
  return params.targetKind === "session-key"
    ? await acquireSqliteSessionWriteLock(params)
    : await acquireFileArtifactLock(params);
}

export async function drainSessionFileWriteLockStateForTest(): Promise<void> {
  await FILE_LOCKS.drain();
  for (const [signal, listener] of signalCleanup) {
    process.off(signal, listener);
  }
  signalCleanup.clear();
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = undefined;
  }
}
