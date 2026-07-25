// Serializes sync and async access to the exec approval policy store.
import fs from "node:fs";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { resolveExecApprovalsPath } from "./exec-approvals-config.js";
import {
  isExecApprovalsLockMissing,
  isExecApprovalsTargetMissing,
  resolveCanonicalExecApprovalsTarget,
} from "./exec-approvals-file-io.js";
import { withFileLock } from "./file-lock.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

const EXEC_APPROVALS_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 30_000,
  // Approval policy is an authorization boundary. A pathname recheck followed
  // by stale-lock unlink cannot prove that a fresh owner was not substituted.
  staleRecovery: "fail-closed",
} as const;
const EXEC_APPROVALS_LOCK_QUEUE = resolveGlobalMap<string, Promise<unknown>>(
  Symbol.for("openclaw.execApprovalsLockQueue"),
);
let execApprovalsProcessStartTime: number | null | undefined;

function getExecApprovalsProcessStartTime(): number | null {
  if (execApprovalsProcessStartTime === undefined) {
    execApprovalsProcessStartTime = getFileLockProcessStartTime(process.pid);
  }
  return execApprovalsProcessStartTime;
}
const EXEC_APPROVALS_SYNC_LOCK_RETRIES = 10;
const EXEC_APPROVALS_SYNC_LOCK_RETRY_MS = 20;

type ExecApprovalsSyncLock = {
  descriptor: number;
  lockPath: string;
  device: number;
  inode: number;
  raw: string;
};

function readLockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readExecApprovalsLockState(lockPath: string): {
  ownerPid: number | null;
  definitelyStale: boolean;
} {
  try {
    const payload = readLockPayload(fs.readFileSync(lockPath, "utf8"));
    const ownerPid =
      typeof payload?.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
        ? payload.pid
        : null;
    return {
      ownerPid,
      definitelyStale: isLockOwnerDefinitelyStale({ payload }),
    };
  } catch {
    return { ownerPid: null, definitelyStale: false };
  }
}

function sleepExecApprovalsSyncLockRetry(): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXEC_APPROVALS_SYNC_LOCK_RETRY_MS);
  } catch {
    const deadline = Date.now() + EXEC_APPROVALS_SYNC_LOCK_RETRY_MS;
    while (Date.now() < deadline) {
      // Best-effort fallback when Atomics.wait is unavailable.
    }
  }
}

function removeOwnedExecApprovalsLock(
  lock: ExecApprovalsSyncLock,
  options: { requirePayloadMatch: boolean },
): void {
  try {
    const current = fs.lstatSync(lock.lockPath);
    if (
      current.dev === lock.device &&
      current.ino === lock.inode &&
      (!options.requirePayloadMatch || fs.readFileSync(lock.lockPath, "utf8") === lock.raw)
    ) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // Best-effort release; a changed path belongs to another lock owner.
  }
}

function acquireExecApprovalsLockSync(filePath: string): ExecApprovalsSyncLock {
  const normalizedTarget = resolveCanonicalExecApprovalsTarget(filePath);
  const lockPath = `${normalizedTarget}.lock`;
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  const starttime = getExecApprovalsProcessStartTime();
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  for (let attempt = 0; attempt <= EXEC_APPROVALS_SYNC_LOCK_RETRIES; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const state = readExecApprovalsLockState(lockPath);
      if (state.definitelyStale) {
        throw Object.assign(new Error(`Exec approvals lock has a stale owner: ${lockPath}`), {
          code: "file_lock_stale",
          lockPath,
        });
      }
      if (
        state.ownerPid !== null &&
        state.ownerPid !== process.pid &&
        attempt < EXEC_APPROVALS_SYNC_LOCK_RETRIES
      ) {
        sleepExecApprovalsSyncLockRetry();
        continue;
      }
      throw Object.assign(new Error(`Exec approvals are locked: ${lockPath}`), {
        code: "file_lock_timeout",
        lockPath,
      });
    }
    let stat: fs.Stats;
    try {
      stat = fs.fstatSync(descriptor);
    } catch (err) {
      fs.closeSync(descriptor);
      throw err;
    }
    const lock: ExecApprovalsSyncLock = {
      descriptor,
      lockPath,
      device: stat.dev,
      inode: stat.ino,
      raw,
    };
    try {
      fs.writeFileSync(descriptor, raw, "utf8");
      return lock;
    } catch (err) {
      fs.closeSync(descriptor);
      removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: false });
      throw err;
    }
  }
  throw new Error(`Failed to acquire exec approvals lock: ${lockPath}`);
}

export function withExecApprovalsLockSync<T>(fn: () => T): T {
  const lock = acquireExecApprovalsLockSync(resolveExecApprovalsPath());
  try {
    return fn();
  } finally {
    fs.closeSync(lock.descriptor);
    removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: true });
  }
}

export function withExecApprovalsReadLockSync<T>(filePath: string, fn: () => T): T {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return withExecApprovalsLockSync(fn);
  }
  // Avoid creating a missing state directory for an uncontended read. Recheck
  // after reading: a writer can create the lock or target between the probes.
  const result = fn();
  // Probe the lock first so the target probe is the final linearization check.
  // A writer that finishes after the lock probe must make the target visible.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : withExecApprovalsLockSync(fn);
}

function enqueueExecApprovalsLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Queue process-local holders before taking the re-entrant shared lock;
  // otherwise concurrent callbacks could both mutate stale state.
  const previous = EXEC_APPROVALS_LOCK_QUEUE.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  EXEC_APPROVALS_LOCK_QUEUE.set(filePath, next);
  void next
    .finally(() => {
      if (EXEC_APPROVALS_LOCK_QUEUE.get(filePath) === next) {
        EXEC_APPROVALS_LOCK_QUEUE.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

export async function withExecApprovalsLock<T>(fn: () => Promise<T>): Promise<T> {
  // Harden and canonicalize before entering either lock layer. This prevents a
  // symlinked state component from redirecting the sidecar and secures the
  // directory even when the guarded update becomes a no-op or loses its CAS.
  const filePath = resolveCanonicalExecApprovalsTarget(resolveExecApprovalsPath());
  return await enqueueExecApprovalsLock(filePath, async () =>
    withFileLock(filePath, EXEC_APPROVALS_LOCK_OPTIONS, fn),
  );
}

export async function withExecApprovalsReadLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return await withExecApprovalsLock(fn);
  }
  const result = await fn();
  // Keep the target probe last for the same missing-file race as the sync path.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : await withExecApprovalsLock(fn);
}
