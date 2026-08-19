/** Process-local cron operation serialization by SQLite store partition. */
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { cronStoreKey } from "../store/key.js";
import type { CronServiceState } from "./state.js";

const cronOperations = new KeyedAsyncQueue();
const pendingSessionCleanups = new Map<string, Map<string, Promise<void>>>();

/** Returns cleanup that must finish before the same durable job identity can be reused. */
export function getPendingCronSessionCleanup(
  state: CronServiceState,
  jobId: string,
): Promise<void> | undefined {
  return pendingSessionCleanups.get(cronStoreKey(state.deps.storePath))?.get(jobId);
}

/** Registers cleanup at the store-partition owner shared by sibling service instances. */
export function registerPendingCronSessionCleanup(
  state: CronServiceState,
  jobId: string,
  done: Promise<void>,
): () => void {
  const storeKey = cronStoreKey(state.deps.storePath);
  let byJobId = pendingSessionCleanups.get(storeKey);
  if (!byJobId) {
    byJobId = new Map<string, Promise<void>>();
    pendingSessionCleanups.set(storeKey, byJobId);
  }
  byJobId.set(jobId, done);
  return () => {
    if (byJobId.get(jobId) !== done) {
      return;
    }
    byJobId.delete(jobId);
    if (byJobId.size === 0) {
      pendingSessionCleanups.delete(storeKey);
    }
  };
}

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/** Serializes operations by their actual SQLite partition and service-local order. */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const previous = state.op;
  const next = cronOperations.enqueue(cronStoreKey(state.deps.storePath), async () => {
    await resolveChain(previous);
    return await fn();
  });
  state.op = resolveChain(next);
  return await next;
}
