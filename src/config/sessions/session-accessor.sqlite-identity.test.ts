import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it.each([false, true])("publishes identity only on outer commit (rollback: %s)", (rollback) => {
  const directory = tempDirs.make("session-identity-publication-");
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  const sessionKey = "agent:main:main";
  const scope = { agentId: "main", sessionKey, storePath: path.join(directory, "agent.sqlite") };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
  const observed: Array<{
    mutation: SessionIdentityMutation;
    inTransaction: boolean;
    sessionId: string | undefined;
  }> = [];
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    observed.push({
      mutation,
      inTransaction: database.db.isTransaction,
      sessionId: readExactSessionEntryRowValidated(database, sessionKey)?.entry.sessionId,
    });
  });
  try {
    const replace = () =>
      runOpenClawAgentWriteTransaction(
        () => {
          replaceSessionEntrySync(scope, { sessionId: "replacement", updatedAt: 2 });
          expect(observed).toEqual([]);
          if (rollback) {
            throw new Error("rollback");
          }
        },
        { agentId: scope.agentId, path: scope.storePath },
      );
    if (rollback) {
      expect(replace).toThrow("rollback");
    } else {
      replace();
    }
    expect(observed).toEqual(
      rollback
        ? []
        : [
            {
              mutation: {
                agentId: scope.agentId,
                kind: "replace",
                previous: { sessionId: "original", sessionKeys: [sessionKey] },
                current: { sessionId: "replacement", sessionKeys: [sessionKey] },
              },
              inTransaction: false,
              sessionId: "replacement",
            },
          ],
    );
    expect(readExactSessionEntryRowValidated(database, sessionKey)?.entry.sessionId).toBe(
      rollback ? "original" : "replacement",
    );
  } finally {
    unsubscribe();
  }
});
