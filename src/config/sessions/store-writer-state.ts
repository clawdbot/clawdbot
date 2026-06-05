// Shared session-store writer queue state and test-only drains.
import {
  clearStoreWriterQueuesForTest,
  drainStoreWriterQueuesForTest,
  type StoreWriterQueue,
  type StoreWriterTask,
} from "../../shared/store-writer-queue.js";
import { clearSessionStoreCaches } from "./store-cache.js";

/** Queued session store write task type. */
export type SessionStoreWriterTask = StoreWriterTask;
export type SessionStoreWriterQueue = StoreWriterQueue;

export const WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();

/** Clears session store writer queues and cache for tests. */
export function clearSessionStoreCacheForTest(): void {
  clearSessionStoreCaches();
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}

export function getSessionStoreWriterQueueSizeForTest(): number {
  return WRITER_QUEUES.size;
}
