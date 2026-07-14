import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { lockWorktreeForProcess, unlockWorktree } from "./git-lock.js";
import {
  abortWorktreeRemovalRow,
  admitWorktreeRunLeaseRow,
  claimWorktreeRemovalRow,
  finalizeWorktreeRemovalRows,
  getRegistryWorktree,
  hasLiveWorktreeRunLeaseRow,
  listRegistryWorktrees,
  releaseWorktreeRunLeaseRow,
  type RunLeaseOwnerChecks,
} from "./registry.js";

const log = createSubsystemLogger("agents/worktrees");

const RELEASE_MAX_ATTEMPTS = 3;

type WorktreeRunLease = {
  id: string;
  token: string;
  release: () => Promise<void>;
};

type HeldWorktreeLock = { refcount: number; gitLocked: boolean };

// The git lock is a per-process single-holder resource; a parent and a same-process
// child that share one worktree refcount it here so a child release does not unlock
// the parent's still-live checkout.
const heldGitLocks = new Map<string, HeldWorktreeLock>();
const gitLockTransitionTails = new Map<string, Promise<void>>();
let ownerChecks: RunLeaseOwnerChecks = {};
let resolveSelfStartTime = getFileLockProcessStartTime;
let releaseRunLeaseRow = releaseWorktreeRunLeaseRow;
let unlockWorktreeImpl = unlockWorktree;

// A cleanup that could not finish (persistent state-database delete or git unlock
// failure) is retained here so the process keeps ownership of it and retries on the
// next lease acquisition and at exit, instead of stranding the row and git guard.
type LeaseCleanup = {
  env: NodeJS.ProcessEnv;
  id: string;
  token: string;
  rowDeleted: boolean;
  refcountReleased: boolean;
  gitUnlockPending: boolean;
};
const pendingLeaseCleanups = new Set<LeaseCleanup>();
let exitCleanupRegistered = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withGitLockTransition<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = gitLockTransitionTails.get(id) ?? Promise.resolve();
  let finish!: () => void;
  const current = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tail = previous.then(() => current);
  gitLockTransitionTails.set(id, tail);
  await previous;
  try {
    return await operation();
  } finally {
    finish();
    if (gitLockTransitionTails.get(id) === tail) {
      gitLockTransitionTails.delete(id);
    }
  }
}

async function retainGitLock(env: NodeJS.ProcessEnv, id: string): Promise<void> {
  await withGitLockTransition(id, async () => {
    const held = heldGitLocks.get(id) ?? { refcount: 0, gitLocked: false };
    const needsLock = held.refcount === 0 && !held.gitLocked;
    held.refcount += 1;
    heldGitLocks.set(id, held);
    if (!needsLock) {
      return;
    }
    const record = getRegistryWorktree(env, id);
    if (!record) {
      return;
    }
    try {
      await lockWorktreeForProcess(record);
      held.gitLocked = true;
    } catch (error) {
      log.warn(`worktree git lock unavailable for ${id}: ${errorMessage(error)}`);
    }
  });
}

async function releaseGitLock(cleanup: LeaseCleanup): Promise<boolean> {
  return await withGitLockTransition(cleanup.id, async () => {
    let held = heldGitLocks.get(cleanup.id);
    if (!cleanup.refcountReleased) {
      cleanup.refcountReleased = true;
      if (held) {
        held.refcount -= 1;
      }
    }
    held = heldGitLocks.get(cleanup.id);
    if (!held) {
      cleanup.gitUnlockPending = false;
      return true;
    }
    if (held.refcount > 0) {
      // A newer holder adopted a guard whose prior unlock failed. Its own final
      // release now owns the unlock; stale cleanup must not drop that generation.
      cleanup.gitUnlockPending = false;
      return true;
    }
    if (!held.gitLocked) {
      heldGitLocks.delete(cleanup.id);
      cleanup.gitUnlockPending = false;
      return true;
    }
    const record = getRegistryWorktree(cleanup.env, cleanup.id);
    if (!record) {
      heldGitLocks.delete(cleanup.id);
      cleanup.gitUnlockPending = false;
      return true;
    }
    try {
      await unlockWorktreeImpl(record);
    } catch (error) {
      cleanup.gitUnlockPending = true;
      log.warn(`failed to unlock worktree ${cleanup.id}: ${errorMessage(error)}`);
      return false;
    }
    heldGitLocks.delete(cleanup.id);
    cleanup.gitUnlockPending = false;
    return true;
  });
}

async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export async function resolveWorktreeIdForPath(params: {
  sessionEntry?: { worktree?: { id: string } };
  candidatePaths: Array<string | undefined>;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const boundId = params.sessionEntry?.worktree?.id;
  if (boundId !== undefined) {
    // The session's stored binding is authoritative: if that worktree is gone the
    // run must fail closed rather than silently continue as an unmanaged directory.
    const record = getRegistryWorktree(env, boundId);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`managed worktree was removed: ${record?.path ?? boundId}`);
    }
    return boundId;
  }
  const records = listRegistryWorktrees(env).filter((record) => record.removedAt === undefined);
  if (records.length === 0) {
    return undefined;
  }
  const bases = new Map<string, string>();
  for (const record of records) {
    bases.set(record.id, await realpathOrSelf(record.path));
  }
  const seen = new Set<string>();
  for (const candidate of params.candidatePaths) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const real = await realpathOrSelf(candidate);
    for (const record of records) {
      const base = bases.get(record.id);
      if (base && (real === base || real.startsWith(`${base}${path.sep}`))) {
        return record.id;
      }
    }
  }
  return undefined;
}

function deleteRunLeaseRowWithRetries(cleanup: LeaseCleanup): boolean {
  for (let attempt = 1; attempt <= RELEASE_MAX_ATTEMPTS; attempt += 1) {
    try {
      releaseRunLeaseRow(cleanup.env, cleanup.id, cleanup.token);
      return true;
    } catch (error) {
      log.warn(
        `failed to release worktree run lease for ${cleanup.id} (attempt ${attempt}): ${errorMessage(error)}`,
      );
    }
  }
  return false;
}

// Drives a lease cleanup as far as it can and returns true only once both the token
// row and the git guard are released. Keeps everything until each step succeeds so a
// removal stays correctly blocked while cleanup is still owed.
async function runLeaseCleanup(cleanup: LeaseCleanup): Promise<boolean> {
  if (!cleanup.rowDeleted) {
    if (!deleteRunLeaseRowWithRetries(cleanup)) {
      return false;
    }
    cleanup.rowDeleted = true;
  }
  return await releaseGitLock(cleanup);
}

async function drainPendingLeaseCleanups(): Promise<void> {
  for (const cleanup of pendingLeaseCleanups) {
    if (await runLeaseCleanup(cleanup)) {
      pendingLeaseCleanups.delete(cleanup);
    }
  }
}

function ensureExitCleanupRegistered(): void {
  if (exitCleanupRegistered) {
    return;
  }
  exitCleanupRegistered = true;
  // A row that never deleted keeps its worktree unremovable until this process ends;
  // delete it synchronously on exit so a live-pid lease row does not linger.
  process.on("exit", () => {
    for (const cleanup of pendingLeaseCleanups) {
      if (!cleanup.rowDeleted) {
        try {
          releaseRunLeaseRow(cleanup.env, cleanup.id, cleanup.token);
        } catch {
          // Best effort at exit; the dead pid also lets a later process prune it.
        }
      }
    }
  });
}

export async function acquireWorktreeRunLease(
  id: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<WorktreeRunLease> {
  const env = opts.env ?? process.env;
  ensureExitCleanupRegistered();
  // Retry any cleanup a prior run could not finish before starting a new one.
  await drainPendingLeaseCleanups();
  const token = randomUUID();
  const pid = process.pid;
  const startTime = resolveSelfStartTime(pid);
  admitWorktreeRunLeaseRow(env, {
    worktreeId: id,
    token,
    pid,
    startTime,
    now: Date.now(),
    checks: ownerChecks,
  });
  // Serialize refcount and Git transitions so a cleanup retry cannot unlock a
  // newer same-process holder after a prior generation's unlock failed.
  await retainGitLock(env, id);
  const cleanup: LeaseCleanup = {
    env,
    id,
    token,
    rowDeleted: false,
    refcountReleased: false,
    gitUnlockPending: false,
  };
  let released = false;
  return {
    id,
    token,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      if (!(await runLeaseCleanup(cleanup))) {
        pendingLeaseCleanups.add(cleanup);
      }
    },
  };
}

export function claimWorktreeRemoval(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; token: string; force: boolean },
): void {
  const pid = process.pid;
  claimWorktreeRemovalRow(env, {
    ...params,
    pid,
    startTime: resolveSelfStartTime(pid),
    now: Date.now(),
    checks: ownerChecks,
  });
}

export function finalizeWorktreeRemoval(env: NodeJS.ProcessEnv, worktreeId: string): void {
  finalizeWorktreeRemovalRows(env, worktreeId);
}

export function abortWorktreeRemoval(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  abortWorktreeRemovalRow(env, worktreeId, token);
}

export function hasLiveWorktreeRunLease(env: NodeJS.ProcessEnv, worktreeId: string): boolean {
  return hasLiveWorktreeRunLeaseRow(env, worktreeId, ownerChecks);
}

export const testing = {
  setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void {
    resolveSelfStartTime = resolver ?? getFileLockProcessStartTime;
    ownerChecks = { ...ownerChecks, getProcessStartTime: resolver ?? undefined };
  },
  setDeadPidResolverForTest(resolver: ((pid: number) => boolean) | null): void {
    ownerChecks = { ...ownerChecks, isPidDefinitelyDead: resolver ?? undefined };
  },
  setReleaseRowImplForTest(impl: typeof releaseWorktreeRunLeaseRow | null): void {
    releaseRunLeaseRow = impl ?? releaseWorktreeRunLeaseRow;
  },
  setUnlockImplForTest(impl: typeof unlockWorktree | null): void {
    unlockWorktreeImpl = impl ?? unlockWorktree;
  },
  async drainPendingCleanupsForTest(): Promise<void> {
    await drainPendingLeaseCleanups();
  },
  resetForTest(): void {
    heldGitLocks.clear();
    gitLockTransitionTails.clear();
    pendingLeaseCleanups.clear();
    ownerChecks = {};
    resolveSelfStartTime = getFileLockProcessStartTime;
    releaseRunLeaseRow = releaseWorktreeRunLeaseRow;
    unlockWorktreeImpl = unlockWorktree;
  },
};
