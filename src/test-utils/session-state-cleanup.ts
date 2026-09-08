// Cleans session-related shared state after tests.
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../config/sessions/session-transcript-reconcile.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
} from "../config/sessions/store-writer-state.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

let fileLockDrainerForTests: typeof drainFileLockStateForTest | null = null;
let sessionStoreWriterQueueDrainerForTests: typeof drainSessionStoreWriterQueuesForTest | null =
  null;

/** Overrides cleanup hooks so tests can drain mocked session state modules. */
export function setSessionStateCleanupRuntimeForTests(params: {
  drainFileLockStateForTest?: typeof drainFileLockStateForTest | null;
  drainSessionStoreWriterQueuesForTest?: typeof drainSessionStoreWriterQueuesForTest | null;
}): void {
  if ("drainFileLockStateForTest" in params) {
    fileLockDrainerForTests = params.drainFileLockStateForTest ?? null;
  }
  if ("drainSessionStoreWriterQueuesForTest" in params) {
    sessionStoreWriterQueueDrainerForTests = params.drainSessionStoreWriterQueuesForTest ?? null;
  }
}

export function resetSessionStateCleanupRuntimeForTests(): void {
  fileLockDrainerForTests = null;
  sessionStoreWriterQueueDrainerForTests = null;
}

export async function cleanupSessionStateForTest(
  options: { stateDir?: string } = {},
): Promise<void> {
  await (sessionStoreWriterQueueDrainerForTests ?? drainSessionStoreWriterQueuesForTest)();
  if (options.stateDir) {
    // Writers can publish deferred reconciles as the initial drain settles.
    // Finish those owners and their writes before closing fixture databases.
    await waitForSessionTranscriptIndexReconcilesInStateDir(options.stateDir);
    await (sessionStoreWriterQueueDrainerForTests ?? drainSessionStoreWriterQueuesForTest)();
  }
  await (fileLockDrainerForTests ?? drainFileLockStateForTest)();
  clearSessionStoreCacheForTest();
  if (!options.stateDir) {
    return;
  }
  // Close agent handles before shared state: releasing their leases can reopen
  // shared state. Unrelated fixtures keep their handles.
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (isPathInside(options.stateDir, database.path)) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  }
  closeOpenClawStateDatabaseByPath(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: options.stateDir }),
  );
}
