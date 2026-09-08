import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getFileLockProcessStartTime,
  isPidDefinitelyDead,
} from "openclaw/plugin-sdk/process-runtime";
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
const MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS = 40;
const inProcessMemoryWorkspaceLocks = new KeyedAsyncQueue();
const activeMemoryWorkspaceLockOwners = new Map<string, string>();

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
  const pid = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isShortTermLockStealable(
  lockKey: string,
  existing: ShortTermLockEntry,
  nowMs: number,
): boolean {
  if (nowMs - existing.acquiredAt <= SHORT_TERM_LOCK_STALE_MS) {
    return false;
  }
  const ownerPid = parseLockOwnerPid(existing.owner);
  if (ownerPid === null) {
    return true;
  }
  if (ownerPid === process.pid) {
    // The current process can own this row only through the tracked local lease.
    // A same-PID row without that lease survived a prior process or failed cleanup.
    return activeMemoryWorkspaceLockOwners.get(lockKey) !== existing.owner;
  }
  if (isPidDefinitelyDead(ownerPid)) {
    return true;
  }
  // Shipped rows lack start identity. Keep a live foreign PID authoritative.
  if (existing.ownerStartTime === undefined) {
    return false;
  }
  const currentStartTime = getFileLockProcessStartTime(ownerPid);
  return currentStartTime !== null && currentStartTime !== existing.ownerStartTime;
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
      const acquiredAt = Date.now();
      const ownerStartTime = getFileLockProcessStartTime(process.pid);
      const lockEntry: ShortTermLockEntry = {
        owner: `${process.pid}:${acquiredAt}`,
        acquiredAt,
        ...(ownerStartTime === null ? {} : { ownerStartTime }),
      };
      const acquired = await lockStore.registerIfAbsent(lockKey, lockEntry);
      if (acquired) {
        const lease = { key: lockKey, active: true };
        activeMemoryWorkspaceLockOwners.set(lockKey, lockEntry.owner);
        try {
          return await runWorkspaceLockScope(lease, task);
        } finally {
          lease.active = false;
          activeMemoryWorkspaceLockOwners.delete(lockKey);
          await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, lockEntry).catch(() => false);
        }
      }

      const existing = await lockStore.lookup(lockKey);
      if (existing && isShortTermLockStealable(lockKey, existing, Date.now())) {
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
