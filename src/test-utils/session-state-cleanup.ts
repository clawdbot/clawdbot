// Cleans session-related shared state after tests.
import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
} from "../config/sessions/store-writer-state.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";

let fileLockDrainerForTests: typeof drainFileLockStateForTest | null = null;
let sessionStoreWriterQueueDrainerForTests: typeof drainSessionStoreWriterQueuesForTest | null =
  null;
let sessionWriteLockDrainerForTests: typeof drainSessionWriteLockStateForTest | null = null;

/** Overrides cleanup hooks so tests can drain mocked session state modules. */
export function setSessionStateCleanupRuntimeForTests(params: {
  drainFileLockStateForTest?: typeof drainFileLockStateForTest | null;
  drainSessionStoreWriterQueuesForTest?: typeof drainSessionStoreWriterQueuesForTest | null;
  drainSessionWriteLockStateForTest?: typeof drainSessionWriteLockStateForTest | null;
}): void {
  if ("drainFileLockStateForTest" in params) {
    fileLockDrainerForTests = params.drainFileLockStateForTest ?? null;
  }
  if ("drainSessionStoreWriterQueuesForTest" in params) {
    sessionStoreWriterQueueDrainerForTests = params.drainSessionStoreWriterQueuesForTest ?? null;
  }
  if ("drainSessionWriteLockStateForTest" in params) {
    sessionWriteLockDrainerForTests = params.drainSessionWriteLockStateForTest ?? null;
  }
}

export function resetSessionStateCleanupRuntimeForTests(): void {
  fileLockDrainerForTests = null;
  sessionStoreWriterQueueDrainerForTests = null;
  sessionWriteLockDrainerForTests = null;
}

export async function cleanupSessionStateForTest(): Promise<void> {
  await (sessionStoreWriterQueueDrainerForTests ?? drainSessionStoreWriterQueuesForTest)();
  clearSessionStoreCacheForTest();
  await (fileLockDrainerForTests ?? drainFileLockStateForTest)();
  await (sessionWriteLockDrainerForTests ?? drainSessionWriteLockStateForTest)();
}
