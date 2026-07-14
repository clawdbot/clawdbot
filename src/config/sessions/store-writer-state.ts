// Shared session-store writer queue state and test-only drains.
import {
  clearStoreWriterQueuesForTest,
  drainStoreWriterQueuesForTest,
  type StoreWriterQueue,
} from "../../shared/store-writer-queue.js";
import { clearSessionStoreCaches } from "./store-cache.js";

type SessionStoreWriterQueue = StoreWriterQueue;

export const WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();

/** Clears session store writer queues and cache for tests. */
export function clearSessionStoreCacheForTest(): void {
  clearSessionStoreCaches();
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}
