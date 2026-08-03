// Keyed async queue helpers serialize async plugin work by key while preserving parallelism.
/** Optional lifecycle hooks fired around each queued task. */
export type KeyedAsyncQueueHooks = {
  onEnqueue?: () => void;
  onSettle?: () => void;
};

/** Serialize async work per key while allowing unrelated keys to run concurrently. */
export function enqueueKeyedTask<T>(params: {
  tails: Map<string, Promise<void>>;
  key: string;
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
}): Promise<T> {
  params.hooks?.onEnqueue?.();
  const previous = params.tails.get(params.key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(params.task)
    .finally(() => {
      params.hooks?.onSettle?.();
    });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  params.tails.set(params.key, tail);
  const cleanup = () => {
    if (params.tails.get(params.key) === tail) {
      params.tails.delete(params.key);
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}

/** Small per-key async queue wrapper for plugin runtimes that need serialized work. */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * @deprecated Retained for shipped Plugin SDK compatibility. New callers must
   * not depend on queue storage; remove in a declared Plugin SDK breaking window.
   */
  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.tails;
  }

  enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T> {
    return enqueueKeyedTask({
      tails: this.tails,
      key,
      task,
      ...(hooks ? { hooks } : {}),
    });
  }
}
