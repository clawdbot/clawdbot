/** Process-local cron operation serialization by store path. */
import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();
const storeLockPaths = new WeakMap<CronServiceState, string>();

function resolveStoreLockPath(storePath: string): string {
  let existingPath = path.resolve(storePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      // Stores may not exist on first startup. Canonicalize their closest
      // existing ancestor once so symlink aliases still share one lock.
      return path.join(realpathSync.native(existingPath), ...missingSegments.toReversed());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      try {
        // realpath cannot resolve a store-file symlink before its target is
        // created; follow that link before choosing the lock identity.
        const targetPath = readlinkSync(existingPath);
        existingPath = path.resolve(path.dirname(existingPath), targetPath);
        continue;
      } catch (linkError) {
        const linkCode = (linkError as NodeJS.ErrnoException).code;
        if (linkCode !== "EINVAL" && linkCode !== "ENOENT" && linkCode !== "ENOTDIR") {
          throw linkError;
        }
      }
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        return path.resolve(storePath);
      }
      missingSegments.push(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}

function getStoreLockPath(state: CronServiceState): string {
  const cachedPath = storeLockPaths.get(state);
  if (cachedPath) {
    return cachedPath;
  }
  const resolvedPath = resolveStoreLockPath(state.deps.storePath);
  storeLockPaths.set(state, resolvedPath);
  return resolvedPath;
}

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/** Serializes cron operations per store path while preserving state-local operation ordering. */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = getStoreLockPath(state);
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);

  // Store locks are process-local; keep the chain alive after failures so the
  // next operation for this store still waits for the failed one to settle.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  void keepAlive.finally(() => {
    // A newer operation may already own this store; never remove its chain.
    if (storeLocks.get(storePath) === keepAlive) {
      storeLocks.delete(storePath);
    }
  });

  return await next;
}
