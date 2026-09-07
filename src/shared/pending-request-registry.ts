import { createDeferredCore, type Deferred } from "./deferred.js";

export type PendingRequestEntry<TResult, TValue> = Deferred<TResult> & { value: TValue };

type StoredPendingRequest<TResult, TValue> = PendingRequestEntry<TResult, TValue> & {
  timer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
};
type AddPendingRequestOptions<TValue> = {
  value: TValue;
  timeoutMs: number;
  timeoutError: () => unknown;
  onTimeout?: () => void;
  dispose?: () => void;
};

export function createPendingRequestRegistry<TKey, TResult, TValue>() {
  const pending = new Map<TKey, StoredPendingRequest<TResult, TValue>>();
  const release = (entry: StoredPendingRequest<TResult, TValue>) => {
    clearTimeout(entry.timer);
    entry.dispose?.();
  };
  const take = (key: TKey, expected?: PendingRequestEntry<TResult, TValue>) => {
    const entry = pending.get(key);
    if (!entry || (expected && entry !== expected)) {
      return undefined;
    }
    pending.delete(key);
    release(entry);
    return entry;
  };
  const add = (key: TKey, options: AddPendingRequestOptions<TValue>) => {
    if (pending.has(key)) {
      return undefined;
    }
    const entry: StoredPendingRequest<TResult, TValue> = {
      ...createDeferredCore<TResult>(),
      value: options.value,
      dispose: options.dispose,
    };
    pending.set(key, entry);
    entry.timer = setTimeout(() => {
      const timedOut = take(key, entry);
      if (timedOut) {
        timedOut.reject(options.timeoutError());
        options.onTimeout?.();
      }
    }, options.timeoutMs);
    entry.timer.unref?.();
    return entry;
  };
  const rejectAll = (reason: unknown) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      release(entry);
      entry.reject(reason);
    }
  };
  return { add, get: (key: TKey) => pending.get(key), take, rejectAll };
}
