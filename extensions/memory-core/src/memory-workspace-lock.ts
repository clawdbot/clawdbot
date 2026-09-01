import { AsyncLocalStorage } from "node:async_hooks";
import fsSync from "node:fs";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreStateReference,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
/**
 * Store-level backstop for orphaned lock rows: a lock is registered with this
 * TTL, and a row older than it is stealable even when its owner pid answers
 * the liveness probe. Container pid namespaces reset across restarts, so a
 * recycled pid (pid 1 in particular) can keep a dead holder's lock looking
 * alive forever without this age bound.
 */
const SHORT_TERM_LOCK_TTL_MS = 10 * 60_000;
const MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS = 40;
const inProcessMemoryWorkspaceLocks = new KeyedAsyncQueue();

type MemoryWorkspaceLease = { key: string; active: boolean };
type MemoryWorkspaceLockScope = {
  lease: MemoryWorkspaceLease;
  active: boolean;
  childTail: Promise<void>;
  parent: MemoryWorkspaceLockScope | undefined;
};
const memoryWorkspaceLockScopes = new AsyncLocalStorage<MemoryWorkspaceLockScope>();

function findActiveWorkspaceLockScope(key: string): MemoryWorkspaceLockScope | undefined {
  let scope = memoryWorkspaceLockScopes.getStore();
  while (scope) {
    if (!scope.active || !scope.lease.active) {
      return undefined;
    }
    if (scope.lease.key === key) {
      return scope;
    }
    scope = scope.parent;
  }
  return undefined;
}

async function runWorkspaceLockScope<T>(
  lease: MemoryWorkspaceLease,
  task: () => Promise<T>,
): Promise<T> {
  const scope: MemoryWorkspaceLockScope = {
    lease,
    active: true,
    childTail: Promise.resolve(),
    parent: memoryWorkspaceLockScopes.getStore(),
  };
  try {
    return await memoryWorkspaceLockScopes.run(scope, task);
  } finally {
    // Closed async contexts must acquire a new lease. Already accepted children
    // finish before the owner releases the cross-process lock.
    scope.active = false;
    await scope.childTail;
  }
}

export function resolveLockPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_LOCK_NAMESPACE, workspaceDir);
}

function parseLockOwnerPid(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function isProcessLikelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (extractErrorCode(err) === "ESRCH") {
      return false;
    }
    // EPERM and unknown errors remain potentially alive unless procfs proves a zombie.
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const state = status.match(/^State:\s+(\S)/m)?.[1];
    return state !== "Z" && state !== "X";
  } catch {
    // An unreadable proc entry is not enough evidence to steal an active lock.
    return true;
  }
}

/**
 * Decides whether a held lock row may be stolen. Beyond the pid-liveness
 * rule, a row that has outlived the lock TTL is stealable unconditionally:
 * container restarts reset pid namespaces, so a recycled owner pid can answer
 * the liveness probe for a holder that died weeks ago.
 */
export function isShortTermLockStealable(existing: ShortTermLockEntry, nowMs: number): boolean {
  if (nowMs - existing.acquiredAt > SHORT_TERM_LOCK_TTL_MS) {
    return true;
  }
  if (nowMs - existing.acquiredAt <= SHORT_TERM_LOCK_STALE_MS) {
    return false;
  }
  const ownerPid = parseLockOwnerPid(existing.owner);
  return ownerPid === null || !isProcessLikelyAlive(ownerPid);
}

export async function deleteShortTermLockEntryIfCurrent(
  lockStore: PluginStateKeyedStore<ShortTermLockEntry>,
  lockKey: string,
  expected: ShortTermLockEntry,
): Promise<boolean> {
  if (!lockStore.deleteIf) {
    throw new Error("memory-core short-term lock store requires conditional deletion");
  }
  return await lockStore.deleteIf(
    lockKey,
    (current) => current.owner === expected.owner && current.acquiredAt === expected.acquiredAt,
  );
}

export async function withMemoryWorkspaceLock<T>(
  workspaceDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const scope = findActiveWorkspaceLockScope(lockKey);
  if (scope) {
    // Each scope queues its children separately: nested calls can reenter,
    // while Promise.all siblings cannot race read-modify-write operations.
    const child = scope.childTail.then(() => runWorkspaceLockScope(scope.lease, task));
    scope.childTail = child.then(
      () => undefined,
      () => undefined,
    );
    return await child;
  }
  const lockRef = resolveLockPath(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  return await inProcessMemoryWorkspaceLocks.enqueue(lockKey, async () => {
    const startedAt = Date.now();

    while (true) {
      const lockEntry: ShortTermLockEntry = {
        owner: `${process.pid}:${Date.now()}`,
        acquiredAt: Date.now(),
      };
      // The TTL is the durable backstop: an unclean exit leaves a row that
      // self-expires instead of wedging every later sync behind a dead owner.
      const acquired = await lockStore.registerIfAbsent(lockKey, lockEntry, {
        ttlMs: SHORT_TERM_LOCK_TTL_MS,
      });
      if (acquired) {
        const lease = { key: lockKey, active: true };
        try {
          return await runWorkspaceLockScope(lease, task);
        } finally {
          lease.active = false;
          await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, lockEntry).catch(() => false);
        }
      }

      const existing = await lockStore.lookup(lockKey);
      if (existing && isShortTermLockStealable(existing, Date.now())) {
        if (await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, existing)) {
          continue;
        }
      }

      if (Date.now() - startedAt >= MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for memory workspace lock at ${lockRef}`);
      }

      await sleep(MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS);
    }
  });
}
