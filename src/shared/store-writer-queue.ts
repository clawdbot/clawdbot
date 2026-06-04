/** Pending exclusive store write plus the promise hooks for its caller. */
export type StoreWriterTask = {
  /** Write operation to run once earlier tasks for the same store path finish. */
  fn: () => Promise<unknown>;
  /** Resolves the caller's promise with the write result. */
  resolve: (value: unknown) => void;
  /** Rejects the caller's promise with the write failure or test cleanup error. */
  reject: (reason: unknown) => void;
};

/** Per-store-path FIFO queue that serializes file writes within one process. */
export type StoreWriterQueue = {
  /** True while a drain loop owns this queue. */
  running: boolean;
  /** Writes waiting behind the active drain. */
  pending: StoreWriterTask[];
  /** Active drain promise, reused by waiters until the current batch settles. */
  drainPromise: Promise<void> | null;
};

/** Store writer queues keyed by the canonical store path. */
export type StoreWriterQueues = Map<string, StoreWriterQueue>;

function getOrCreateStoreWriterQueue(
  queues: StoreWriterQueues,
  storePath: string,
): StoreWriterQueue {
  const existing = queues.get(storePath);
  if (existing) {
    return existing;
  }
  const created: StoreWriterQueue = { running: false, pending: [], drainPromise: null };
  queues.set(storePath, created);
  return created;
}

async function drainStoreWriterQueue(queues: StoreWriterQueues, storePath: string): Promise<void> {
  const queue = queues.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }
        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        try {
          result = await task.fn();
        } catch (err) {
          hasFailure = true;
          failed = err;
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        queues.delete(storePath);
      } else {
        // Late enqueues after the loop drained run in a fresh microtask so this
        // drainPromise can settle before the next writer batch starts.
        queueMicrotask(() => {
          void drainStoreWriterQueue(queues, storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

/** Runs one store write after prior writes for the same store path have finished. */
export async function runQueuedStoreWrite<T>(params: {
  queues: StoreWriterQueues;
  storePath: string;
  label: string;
  fn: () => Promise<T>;
}): Promise<T> {
  if (!params.storePath || typeof params.storePath !== "string") {
    throw new Error(
      `${params.label}: storePath must be a non-empty string, got ${JSON.stringify(
        params.storePath,
      )}`,
    );
  }
  const queue = getOrCreateStoreWriterQueue(params.queues, params.storePath);
  return await new Promise<T>((resolve, reject) => {
    const task: StoreWriterTask = {
      fn: async () => await params.fn(),
      resolve: (value) => resolve(value as T),
      reject,
    };
    queue.pending.push(task);
    void drainStoreWriterQueue(params.queues, params.storePath);
  });
}

/** Rejects pending queued writes and clears queue state for test cleanup. */
export function clearStoreWriterQueuesForTest(queues: StoreWriterQueues, message: string): void {
  for (const queue of queues.values()) {
    for (const task of queue.pending) {
      task.reject(new Error(message));
    }
  }
  queues.clear();
}

/** Waits for active drains to settle while rejecting still-pending test writes. */
export async function drainStoreWriterQueuesForTest(
  queues: StoreWriterQueues,
  message: string,
): Promise<void> {
  while (queues.size > 0) {
    const activeQueues = [...queues.values()];
    for (const queue of activeQueues) {
      for (const task of queue.pending) {
        task.reject(new Error(message));
      }
      queue.pending.length = 0;
    }
    const activeDrains = activeQueues.flatMap((queue) =>
      queue.drainPromise ? [queue.drainPromise] : [],
    );
    if (activeDrains.length === 0) {
      queues.clear();
      return;
    }
    await Promise.allSettled(activeDrains);
  }
}
