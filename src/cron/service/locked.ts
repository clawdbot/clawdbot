/** Process-local cron operation serialization by store path. */
import path from "node:path";
import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/** Serializes cron operations per store path while preserving state-local operation ordering. */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = path.resolve(state.deps.storePath);
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
