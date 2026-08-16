import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
  readSessionIdentityEvidenceBatch,
  resolveTranscriptSessionKeyBySessionId,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const tempDirs: string[] = [];
const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

function countRegisteredAgentDatabases(env: NodeJS.ProcessEnv): number {
  const row = openOpenClawStateDatabase({ env })
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as { count: number };
  return row.count;
}

function clearRegisteredAgentDatabases(env: NodeJS.ProcessEnv): void {
  openOpenClawStateDatabase({ env }).db.prepare("DELETE FROM agent_databases").run();
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session accessor readonly listing", () => {
  it("returns the same entries as the writable listing for a populated agent database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-populated-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const listScope = { agentId: "worker-1", env };

    await upsertSessionEntryCore(
      { ...listScope, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { ...listScope, sessionKey: "agent:worker-1:telegram:dm:42" },
      { sessionId: "session-2", updatedAt: 20 },
    );
    const writableEntries = listSessionEntriesCore(listScope);
    closeOpenClawAgentDatabasesForTest();

    expect(listSessionEntriesReadOnly(listScope)).toEqual(writableEntries);
  });

  it("returns an empty list without creating or registering a missing agent database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(listSessionEntriesReadOnly({ agentId, env })).toEqual([]);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("probes lifecycle status without creating or registering a missing database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-status-missing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("distinguishes non-session agent state from a running session row", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-status-existing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    openOpenClawAgentDatabase({ agentId, env, path: databasePath });
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);

    await upsertSessionEntryCore(
      { agentId, env, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", status: "running", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["done"])).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("resolves a missing session identity without creating or registering a database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(
      resolveTranscriptSessionKeyBySessionId({ agentId, env, sessionId: "missing-session" }),
    ).toBeUndefined();
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("resolves an existing session identity without registering its database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-existing-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:main";
    await upsertSessionEntryCore(
      { agentId, env, sessionKey },
      { sessionId: "session-1", updatedAt: 1 },
    );
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(resolveTranscriptSessionKeyBySessionId({ agentId, env, sessionId: "session-1" })).toBe(
      sessionKey,
    );
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("batches exact, moved, absent, and unreadable session identity evidence", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-evidence-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:moved";
    const sessionId = "session-1";
    await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    const invalidSessionKey = "agent:worker-1:invalid";
    await upsertSessionEntryCore(
      { agentId, env, sessionKey: invalidSessionKey },
      { sessionId: "invalid-session", updatedAt: 1 },
    );
    openOpenClawAgentDatabase({ agentId, env })
      .db.prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
      .run(invalidSessionKey);
    const migrationInvalidAgentId = "migration-invalid";
    const migrationInvalidSessionKey = "agent:migration-invalid:main";
    await upsertSessionEntryCore(
      { agentId: migrationInvalidAgentId, env, sessionKey: migrationInvalidSessionKey },
      { sessionId: "migration-invalid-session", updatedAt: 1 },
    );
    const invalidDatabase = openOpenClawAgentDatabase({ agentId: migrationInvalidAgentId, env });
    invalidDatabase.db.exec("PRAGMA user_version = 999;");
    const invalidStorePath = invalidDatabase.path;
    const missingAgentId = "missing";
    const missingStorePath = resolveOpenClawAgentSqlitePath({ agentId: missingAgentId, env });
    const unreadableAgentId = "unreadable";
    const unreadableStorePath = resolveOpenClawAgentSqlitePath({
      agentId: unreadableAgentId,
      env,
    });
    fs.mkdirSync(unreadableStorePath, { recursive: true });

    expect(
      readSessionIdentityEvidenceBatch([
        { agentId, sessionId, sessionKey, storePath },
        {
          agentId,
          sessionId,
          sessionKey: "agent:worker-1:old-key",
          storePath,
        },
        { agentId, sessionId: "missing-session", sessionKey, storePath },
        {
          agentId,
          sessionId: "invalid-session",
          sessionKey: invalidSessionKey,
          storePath,
        },
        {
          agentId: missingAgentId,
          sessionId: "missing-session",
          sessionKey: "agent:missing:main",
          storePath: missingStorePath,
        },
        {
          agentId: migrationInvalidAgentId,
          sessionId: "migration-invalid-session",
          sessionKey: migrationInvalidSessionKey,
          storePath: invalidStorePath,
        },
        {
          agentId: unreadableAgentId,
          sessionId: "unreadable-session",
          sessionKey: "agent:unreadable:main",
          storePath: unreadableStorePath,
        },
      ]),
    ).toEqual([
      { status: "current", sessionKey },
      { status: "current", sessionKey },
      { status: "absent" },
      { status: "unknown", reason: "row-invalid" },
      { status: "absent" },
      { status: "unknown", reason: "read-failed" },
      { status: "unknown", reason: "read-failed" },
    ]);
  });

  it("uses the current-session-id index for fallback identity probes", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-evidence-index-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const database = openOpenClawAgentDatabase({ agentId, env });
    const detail = database.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT session_key FROM session_nodes WHERE current_session_id IN (?)",
      )
      .all("session-1")
      .map((row) => {
        const rowDetail = (row as { detail?: unknown }).detail;
        return typeof rowDetail === "string" ? rowDetail : "";
      })
      .join(" ");

    expect(detail).toContain("idx_agent_session_nodes_current_session_id");
  });

  it("does not register a populated database during readonly health-style listing", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-registry-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const scope = { agentId, env };

    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:worker-1:main" },
      { sessionId: "session-1", updatedAt: 10 },
    );
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    closeOpenClawAgentDatabasesForTest();
    clearRegisteredAgentDatabases(env);

    expect(listSessionEntriesReadOnly(scope)).toHaveLength(1);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
  });
});
