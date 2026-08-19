// Cleans session-related shared state after tests.
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
  await (fileLockDrainerForTests ?? drainFileLockStateForTest)();
  clearSessionStoreCacheForTest();
  if (!options.stateDir) {
    return;
  }
  // A queued writer can reopen both databases after an earlier close. Scope
  // final handle cleanup to the fixture owner so unrelated tests stay live.
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (isPathInside(options.stateDir, database.path)) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  }
  closeOpenClawStateDatabaseByPath(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: options.stateDir }),
  );
}
