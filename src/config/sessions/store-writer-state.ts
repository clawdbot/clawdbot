// Shared session-store writer queue state and test-only drains.
import {
  clearStoreWriterQueuesForTest,
  drainStoreWriterQueuesForTest,
  type StoreWriterQueue,
} from "../../shared/store-writer-queue.js";
import { clearSessionSkillPromptRefCache } from "./skill-prompt-blobs.js";

type SessionStoreWriterQueue = StoreWriterQueue;

export const WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();
// State-dir teardown drains this owner before closing SQLite handles. Keeping
// the queue here prevents late session writes from recreating removed fixtures.
export const SQLITE_SESSION_WRITER_QUEUES = new Map<string, SessionStoreWriterQueue>();

/** Clears session writer queues and prompt-blob caches for tests. */
export function clearSessionStoreCacheForTest(): void {
  clearSessionSkillPromptRefCache();
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
  clearStoreWriterQueuesForTest(
    SQLITE_SESSION_WRITER_QUEUES,
    "SQLite session store queue cleared for test",
  );
}

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await Promise.all([
    drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test"),
    drainStoreWriterQueuesForTest(
      SQLITE_SESSION_WRITER_QUEUES,
      "SQLite session store queue cleared for test",
    ),
  ]);
}
