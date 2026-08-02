/** Process-local cron operation serialization by SQLite store partition. */
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { cronStoreKey } from "../store/key.js";
import type { CronServiceState } from "./state.js";

const cronOperations = new KeyedAsyncQueue();

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
