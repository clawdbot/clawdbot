// Shared session-store writer queue state and test-only drains.
import {
  clearStoreWriterQueuesForTest,
  drainStoreWriterQueuesForTest,
  type StoreWriterQueue,
} from "../../shared/store-writer-queue.js";
import { clearSessionSkillPromptRefCache } from "./skill-prompt-blobs.js";

type SessionStoreWriterQueue = StoreWriterQueue;

export const WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();

/** Clears legacy session writer queues and prompt-blob caches for tests. */
export function clearSessionStoreCacheForTest(): void {
  clearSessionSkillPromptRefCache();
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
}
