import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryReadOnly,
  openSessionEntryReadView,
  readSessionTranscriptTitleProbeBatch,
  readSessionTranscriptWatermark,
  readSessionTranscriptWatermarkBatch,
  readSessionIdentityEvidenceBatch,
  readSessionStoreSummaryReadOnly,
  replaceSessionEntrySync,
  resolveTranscriptSessionKeyBySessionId,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

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
    const database = expectDefined(getOpenClawAgentDatabaseIfOpen(listScope), "held agent store");
    const handle = database.db;
    const expectedSummary = {
      count: 2,
      recent: writableEntries.toReversed(),
      byAgent: new Map([[listScope.agentId, { count: 2, recent: writableEntries.toReversed() }]]),
    };
    const summaryOptions = { recentLimit: 2, agentIds: [listScope.agentId] };

    expect(readSessionStoreSummaryReadOnly(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(getOpenClawAgentDatabaseIfOpen(listScope)).toBe(database);
    expect(database.db).toBe(handle);
    expect(handle.isOpen).toBe(true);
    expect(handle.isTransaction).toBe(false);
    closeOpenClawAgentDatabasesForTest();

    expect(listSessionEntriesReadOnly(listScope)).toEqual(writableEntries);
    expect(openSessionEntryReadView(listScope).entries()).toEqual(writableEntries);
    expect(readSessionStoreSummaryReadOnly(listScope, summaryOptions)).toEqual(expectedSummary);
    expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(listScope))).toBe(false);
  });

  it("returns an empty list without creating or registering a missing agent database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    clearRegisteredAgentDatabases(env);

    expect(listSessionEntriesReadOnly({ agentId, env })).toEqual([]);
    expect(openSessionEntryReadView({ agentId, env }).entries()).toEqual([]);
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { agentId, env, sessionKeys: [`agent:${agentId}:main`] },
      ]),
    ).toEqual([{ ok: true, value: [] }]);
    expect(
      readSessionStoreSummaryReadOnly(
        { agentId, env },
        {
          recentLimit: 10,
          agentIds: [agentId],
        },
      ),
    ).toEqual({
      count: 0,
      recent: [],
      byAgent: new Map([[agentId, { count: 0, recent: [] }]]),
    });
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(countRegisteredAgentDatabases(env)).toBe(0);
  });

  it("summarizes pending rows, hidden keys, retained windows, and ties with listing semantics", () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-session-summary-rows-") };
    const scope = { agentId: "main", env };
    for (const [key, updatedAt] of [
      ["zero", 0],
      ["tie-b", 20],
      ["tie-a", 20],
      ["pending", 10],
      ["bad-json", 15],
      ["bad-timestamp", 16],
      ["ordinary:internal-session-effects:visible", 5],
      ["internal-session-effects:hidden", 999],
    ] as const) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${key}` },
        { sessionId: key, updatedAt },
      );
    }
    for (const sessionKey of ["global", "unknown"]) {
      replaceSessionEntrySync({ ...scope, sessionKey }, { sessionId: sessionKey, updatedAt: 1000 });
    }
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        { ...scope, sessionKey: "agent:main:retained", sessionId: "retained" },
        2000,
      );
    }, scope);
    listSessionEntriesReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    const update = database.db.prepare(
      "UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?",
    );
    update.run(
      JSON.stringify({ sessionId: "pending-updated", updatedAt: 30, label: "fresh" }),
      30,
      "agent:main:pending",
    );
    update.run("{", 40, "agent:main:bad-json");
    update.run(
      JSON.stringify({ sessionId: "bad-timestamp", updatedAt: 99 }),
      50,
      "agent:main:bad-timestamp",
    );
    const expectedKeys = [
      "agent:main:pending",
      "agent:main:tie-a",
      "agent:main:tie-b",
      "agent:main:ordinary:internal-session-effects:visible",
      "agent:main:zero",
    ];
    const options = { recentLimit: 3, agentIds: [scope.agentId] };

    const listed = listSessionEntriesReadOnly({ ...scope, readConsistency: "latest" });
    expect(
      listed
        .filter(({ sessionKey }) => !["global", "unknown"].includes(sessionKey))
        .map(({ sessionKey }) => sessionKey)
        .toSorted(),
    ).toEqual(expectedKeys.toSorted());
    const summary = readSessionStoreSummaryReadOnly(scope, options);
    expect(summary.count).toBe(5);
    expect(summary.recent.map(({ sessionKey }) => sessionKey)).toEqual(expectedKeys.slice(0, 3));
    expect(summary.recent[0]?.entry).toMatchObject({
      sessionId: "pending-updated",
      label: "fresh",
    });
    expectDefined(summary.recent[0], "recent pending session").entry.label = "caller-owned";
    expect(readSessionStoreSummaryReadOnly(scope, options).recent[0]?.entry.label).toBe("fresh");
    expect(readSessionStoreSummaryReadOnly(scope, { ...options, recentLimit: 0 })).toEqual({
      count: 5,
      recent: [],
      byAgent: new Map([[scope.agentId, { count: 5, recent: [] }]]),
    });

    const retainedScope = { ...scope, sessionKey: "agent:main:retained" };
    const exactReadFailure = {
      ok: false,
      error: expect.objectContaining({ message: expect.stringContaining("openclaw doctor --fix") }),
    };
    for (const projection of ["full", "list"] as const) {
      expect(loadExactSessionEntryReadOnly({ ...retainedScope, projection })).toBeUndefined();
      for (const key of ["pending", "bad-json", "bad-timestamp"]) {
        expect(() =>
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: `agent:main:${key}`, projection }),
        ).toThrow("openclaw doctor --fix");
      }
      const grouped = loadExactSessionEntryCandidatesReadOnlyBatch(
        [
          ["agent:main:tie-b"],
          ["agent:main:pending"],
          ["agent:main:bad-json"],
          ["agent:main:tie-a", "agent:main:bad-timestamp"],
          ["agent:main:tie-a"],
          [retainedScope.sessionKey, "agent:main:missing"],
        ].map((sessionKeys) => ({ agentId: scope.agentId, env, sessionKeys, projection })),
      );
      expect(grouped).toMatchObject([
        {
          ok: true,
          value: [{ sessionKey: "agent:main:tie-b", entry: { sessionId: "tie-b" } }],
        },
        exactReadFailure,
        exactReadFailure,
        exactReadFailure,
        { ok: true, value: [{ sessionKey: "agent:main:tie-a", entry: { sessionId: "tie-a" } }] },
        { ok: true, value: [] },
      ]);
    }
    update.run(
      JSON.stringify({ skillsSnapshot: { prompt: "invalid prompt-only row" } }),
      2000,
      retainedScope.sessionKey,
    );
    expect(() => loadExactSessionEntryReadOnly({ ...retainedScope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );

    closeOpenClawAgentDatabasesForTest();
    expect(() => readSessionStoreSummaryReadOnly(scope, options)).toThrow("openclaw doctor --fix");
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch(
        ["agent:main:pending", "agent:main:tie-a"].map((sessionKey) => ({
          agentId: scope.agentId,
          env,
          sessionKeys: [sessionKey],
        })),
      ),
    ).toEqual([exactReadFailure, exactReadFailure]);
  });

  it("surfaces missing canonical transcript tables through single and batched reads", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-session-readonly-missing-transcript-table-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const scope = {
      agentId: "worker-1",
      env,
      sessionId: "session-1",
      sessionKey: "agent:worker-1:main",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    openOpenClawAgentDatabase({ agentId: scope.agentId, env }).db.exec(
      "DROP TABLE transcript_events;",
    );

    for (const read of [
      () => readSessionTranscriptWatermark(scope),
      () => readSessionTranscriptWatermarkBatch([scope]),
      () => readSessionTranscriptTitleProbeBatch([scope]),
    ]) {
      expect(read).toThrow(/no such table: transcript_events/);
    }
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

  it("does not prefer a main key when only a shared physical session identity is known", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-shared-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionId = "shared-generation";
    const mainKey = "agent:worker-1:main";
    const otherKey = "agent:worker-1:other";
    for (const sessionKey of [mainKey, otherKey]) {
      await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    }
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
    const probe = { agentId, env, sessionId, storePath };

    expect(
      readSessionIdentityEvidenceBatch([
        probe,
        { ...probe, sessionKey: mainKey },
        { ...probe, sessionKey: otherKey },
      ]),
    ).toEqual([
      { status: "unknown", reason: "ambiguous" },
      { status: "current", sessionKey: mainKey },
      { status: "current", sessionKey: otherKey },
    ]);
  });

  it("rejects stale valid projections for unreadable session identity evidence", async () => {
    const stateDir = autoTempDirs.make("openclaw-session-readonly-stale-valid-evidence-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionId = "session-1";
    const sessionKey = "agent:worker-1:main";
    await upsertSessionEntryCore({ agentId, env, sessionKey }, { sessionId, updatedAt: 1 });
    const readableSessionId = "session-2";
    const readableSessionKey = "agent:worker-1:readable";
    await upsertSessionEntryCore(
      { agentId, env, sessionKey: readableSessionKey },
      { sessionId: readableSessionId, updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId, env });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(JSON.stringify({ sessionId: "mismatched-session", updatedAt: 1 }), sessionKey);
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);

    expect(
      readSessionIdentityEvidenceBatch([
        { agentId, sessionId, sessionKey, storePath: database.path },
        {
          agentId,
          sessionId,
          sessionKey: "agent:worker-1:old-key",
          storePath: database.path,
        },
        {
          agentId,
          sessionId: readableSessionId,
          sessionKey: readableSessionKey,
          storePath: database.path,
        },
      ]),
    ).toEqual([
      { status: "unknown", reason: "row-invalid" },
      { status: "unknown", reason: "row-invalid" },
      { status: "current", sessionKey: readableSessionKey },
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
