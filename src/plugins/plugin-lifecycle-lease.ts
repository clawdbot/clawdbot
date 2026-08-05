// Serializes plugin payload and installed-index mutations across lifecycle commands.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock, type FileLockHandle } from "../infra/file-lock.js";

const LIFECYCLE_LOCK_NAME = ".openclaw-plugin-lifecycle";
const LOCK_OPTIONS = {
  retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
  stale: 30 * 60 * 1000,
} as const;
const activeTargets = new Set<string>();
type LifecycleOwnership = {
  accepting: boolean;
  pendingChildren: number;
  drainWaiters: Array<() => void>;
};
const heldLifecycleTargets = new AsyncLocalStorage<ReadonlyMap<string, LifecycleOwnership>>();

async function resolveLifecycleTarget(extensionsDir: string): Promise<string> {
  await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
  return path.join(await fs.realpath(extensionsDir), LIFECYCLE_LOCK_NAME);
}

async function runReentrantChild<T>(
  owner: LifecycleOwnership,
  operation: () => Promise<T>,
): Promise<T> {
  owner.pendingChildren += 1;
  try {
    return await operation();
  } finally {
    owner.pendingChildren -= 1;
    if (owner.pendingChildren === 0) {
      for (const resolve of owner.drainWaiters.splice(0)) {
        resolve();
      }
    }
  }
}

async function waitForOwnedChildren(owner: LifecycleOwnership): Promise<void> {
  if (owner.pendingChildren === 0) {
    return;
  }
  await new Promise<void>((resolve) => owner.drainWaiters.push(resolve));
}

export class PluginLifecycleLeaseUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("exclusive plugin lifecycle lease unavailable", options);
    this.name = "PluginLifecycleLeaseUnavailableError";
  }
}

/** Acquires the process-and-host-wide lease shared by install, update, uninstall, and guarded replace. */
export async function acquirePluginLifecycleLease(extensionsDir: string): Promise<FileLockHandle> {
  const target = await resolveLifecycleTarget(extensionsDir);
  if (activeTargets.has(target)) {
    throw new PluginLifecycleLeaseUnavailableError();
  }
  activeTargets.add(target);
  try {
    const lock = await acquireFileLock(target, LOCK_OPTIONS);
    let released = false;
    return {
      lockPath: lock.lockPath,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await lock.release();
        } finally {
          activeTargets.delete(target);
        }
      },
    };
  } catch (error) {
    activeTargets.delete(target);
    throw new PluginLifecycleLeaseUnavailableError({ cause: error });
  }
}

/** Runs one complete plugin lifecycle mutation while holding the shared lease. */
export async function withPluginLifecycleLease<T>(
  extensionsDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const target = await resolveLifecycleTarget(extensionsDir);
  const inherited = heldLifecycleTargets.getStore();
  const inheritedOwner = inherited?.get(target);
  if (inheritedOwner?.accepting) {
    return await runReentrantChild(inheritedOwner, operation);
  }
  const lease = await acquirePluginLifecycleLease(extensionsDir);
  const owner: LifecycleOwnership = {
    accepting: true,
    pendingChildren: 0,
    drainWaiters: [],
  };
  try {
    return await heldLifecycleTargets.run(
      new Map([...(inherited?.entries() ?? []), [target, owner]]),
      operation,
    );
  } finally {
    // Revoke inherited authority before releasing the physical lock. Children
    // that already entered remain counted; delayed descendants must reacquire.
    owner.accepting = false;
    await waitForOwnedChildren(owner);
    await lease.release();
  }
}
