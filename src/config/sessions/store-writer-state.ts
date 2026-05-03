import { clearSessionStoreCaches } from "./store-cache.js";

export type SessionStoreWriterTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export type SessionStoreWriterQueue = {
  running: boolean;
  pending: SessionStoreWriterTask[];
  drainPromise: Promise<void> | null;
};

export const WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();

export function clearSessionStoreCacheForTest(): void {
  clearSessionStoreCaches();
  for (const queue of WRITER_QUEUES.values()) {
    for (const task of queue.pending) {
      task.reject(new Error("session store queue cleared for test"));
    }
  }
  WRITER_QUEUES.clear();
}

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  while (WRITER_QUEUES.size > 0) {
    const queues = [...WRITER_QUEUES.values()];
    for (const queue of queues) {
      for (const task of queue.pending) {
        task.reject(new Error("session store queue cleared for test"));
      }
      queue.pending.length = 0;
    }
    const activeDrains = queues.flatMap((queue) =>
      queue.drainPromise ? [queue.drainPromise] : [],
    );
    if (activeDrains.length === 0) {
      WRITER_QUEUES.clear();
      return;
    }
    await Promise.allSettled(activeDrains);
  }
}

export function getSessionStoreWriterQueueSizeForTest(): number {
  return WRITER_QUEUES.size;
}
