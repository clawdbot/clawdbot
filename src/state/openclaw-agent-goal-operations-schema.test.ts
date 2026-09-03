import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { lookupSessionGoalOperation } from "../config/sessions/goals-operations.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { ensureSessionGoalOperationsSchema } from "./openclaw-agent-goal-operations-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

function previousSchema(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS session_goal_operations (",
  );
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS transcript_events (",
    start,
  );
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(0, start) + OPENCLAW_AGENT_SCHEMA_SQL.slice(end);
}

describe("Goal operation additive schema", () => {
  it("keeps old databases table-free on reads, lazily installs once, and survives older-reader use and candidate reopen", () => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-goal-schema-") },
    };
    const initial = openOpenClawAgentDatabase(options);
    const databasePath = initial.path;
    closeOpenClawAgentDatabasesForTest();
    const previous = new DatabaseSync(databasePath);
    previous.exec("DROP TABLE session_goal_operations");
    const version = previous.prepare("PRAGMA user_version").get();
    const metadata = previous
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    previous.close();

    expect(
      lookupSessionGoalOperation({
        ...options,
        sessionKey: "agent:main:goal",
        expectedSessionId: "session-1",
        operation: {
          action: "start",
          objective: "finish",
          operationId: "op-1",
          issuedAtMs: Date.now(),
          requestFingerprint: "request-1",
        },
      }),
    ).toBeUndefined();
    const candidate = openOpenClawAgentDatabase(options);
    expect(
      candidate.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_goal_operations'")
        .get(),
    ).toBeUndefined();
    ensureSessionGoalOperationsSchema(candidate.db);
    ensureSessionGoalOperationsSchema(candidate.db);
    candidate.db
      .prepare("INSERT INTO session_goal_operations VALUES (?, ?, ?, ?, ?, ?)")
      .run("agent:main:goal", "op-1", "session-1", "request-1", "{}", Date.now() + 60_000);
    closeOpenClawAgentDatabasesForTest();

    // The previous version can open and use canonical tables with populated receipt data present.
    const olderReader = new DatabaseSync(databasePath);
    assertSqliteSchemaContains(olderReader, databasePath, previousSchema());
    olderReader
      .prepare("UPDATE schema_meta SET updated_at = updated_at WHERE meta_key = 'primary'")
      .run();
    expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(
      olderReader
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadata);
    olderReader.close();

    const reopened = openOpenClawAgentDatabase(options);
    expect(reopened.db.prepare("SELECT operation_id FROM session_goal_operations").get()).toEqual({
      operation_id: "op-1",
    });
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(version);
  });

  it("rejects a drifted receipt table instead of treating it as an optional absence", () => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-goal-schema-drift-") },
    };
    const pathname = openOpenClawAgentDatabase(options).path;
    closeOpenClawAgentDatabasesForTest();
    const drifted = new DatabaseSync(pathname);
    drifted.exec(
      "DROP TABLE session_goal_operations; CREATE TABLE session_goal_operations (operation_id TEXT NOT NULL PRIMARY KEY) STRICT",
    );
    drifted.close();
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_goal_operations|schema/u);
  });
});
