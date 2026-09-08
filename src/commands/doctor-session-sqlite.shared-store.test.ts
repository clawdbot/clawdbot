import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  lookupSessionGoalOperation,
  type SessionGoalOperation,
} from "../config/sessions/goals-operations.js";
import {
  loadExactSessionEntry,
  listSessionParticipantsReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "../state/openclaw-agent-session-participants-schema.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function createStore(layout: "shared" | "custom") {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-doctor-canonical-store-"));
  const stateDir = path.join(root, "state");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(
    root,
    "custom",
    layout === "shared" ? "shared.sqlite" : "sessions.json",
  );
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { qa: {} } },
    session: { store: storePath },
  };
  const scope = {
    agentId: "qa",
    defaultAgentId: "main",
    env,
    sessionKey: "agent:qa:doctor",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: "doctor-session", updatedAt: 1 });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const sqlitePath = resolveOpenClawAgentSqlitePath(options);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { cfg, env, options, scope, sqlitePath, stateDir, storePath };
}

async function createHistoricalSharedStore(corruptIndex = false, schemaVersion: 17 | 18 = 17) {
  const store = await createStore("shared");
  const goalOperation = {
    action: "start",
    operationId: "goal-before-participant-upgrade",
    issuedAtMs: Date.now(),
    requestFingerprint: "shared-store-goal-fixture",
    objective: "Preserve this Goal across the participant migration.",
  } satisfies SessionGoalOperation;
  const turn = await persistSessionTranscriptTurn(
    { ...store.scope, sessionId: "doctor-session" },
    {
      expectedSessionId: "doctor-session",
      messages: [{ message: { role: "user", content: goalOperation.objective } }],
      sessionTurnMutation: { kind: "goal", operation: goalOperation, runId: "goal-start" },
      updateMode: "none",
    },
  );
  const goalReceipt = turn.sessionTurnMutationResult?.result;
  expect(goalReceipt).toMatchObject({ action: "start", status: "started", runId: "goal-start" });
  expect(
    lookupSessionGoalOperation({
      ...store.scope,
      expectedSessionId: "doctor-session",
      operation: goalOperation,
    }),
  ).toEqual(goalReceipt);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const database = openNodeSqliteDatabase(store.sqlitePath);
  try {
    const goalState = readStoredGoalState(database, store.scope.sessionKey);
    // v17 has legacy participant columns; v18 already has the current table.
    // v19 changes creator data only, so restore its unqualified historical shape.
    if (schemaVersion === 17) {
      database.exec("DROP TABLE session_participants;");
      database.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
      database
        .prepare(
          "INSERT INTO session_participants VALUES (?, 'human', 'person', 'profile', 3, 10, 20)",
        )
        .run(store.scope.sessionKey);
    } else {
      database
        .prepare(
          `INSERT INTO session_participants VALUES (?, '{"type":"profile"}', 'person', 3, 10, 20)`,
        )
        .run(store.scope.sessionKey);
    }
    database
      .prepare(
        `UPDATE session_nodes SET entry_json = json_set(entry_json,
          '$.createdVia', 'operator', '$.createdAt', 5,
          '$.createdActor', json('{"type":"human","id":"person","label":"Original creator"}'))
         WHERE session_key = ?`,
      )
      .run(store.scope.sessionKey);
    database.exec(
      `PRAGMA user_version = ${schemaVersion}; UPDATE schema_meta SET schema_version = ${schemaVersion};`,
    );
    if (corruptIndex) {
      database.exec(`
        INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
          VALUES ('doctor', 'preserved', '{"ok":true}', 100, 1);
        DROP INDEX idx_agent_cache_expiry;
        CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
      `);
      database.enableDefensive?.(false);
      database.exec(`PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry';
        PRAGMA writable_schema = OFF;`);
      const schemaCookie = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
      database.exec(`PRAGMA schema_version = ${schemaCookie + 1};`);
    }
    return { ...store, goalOperation, goalReceipt, goalState, schemaVersion };
  } finally {
    database.close();
  }
}

function readStoredGoalState(
  database: ReturnType<typeof openNodeSqliteDatabase>,
  sessionKey: string,
) {
  return {
    goal: database
      .prepare(
        "SELECT json_extract(entry_json, '$.goal') AS goal_json FROM session_nodes WHERE session_key = ?",
      )
      .get(sessionKey),
    receipts: database
      .prepare("SELECT * FROM session_goal_operations WHERE session_key = ? ORDER BY operation_id")
      .all(sessionKey),
    ddl: database
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'session_goal_operations' ORDER BY name",
      )
      .all(),
  };
}

async function repairHistoricalSharedStore(
  store: Awaited<ReturnType<typeof createStore>>,
  mode: "import-finalize" | "recover",
) {
  if (mode === "import-finalize") {
    const result = await compactDoctorSessionSqliteTarget(
      { agentId: "qa", storePath: store.storePath },
      { env: store.env, operation: mode },
    );
    expect(result.skipped).toBe(false);
  } else {
    const report = await runDoctorSessionSqlite({
      cfg: store.cfg,
      env: store.env,
      allAgents: true,
      mode,
    });
    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
  }
}

function expectUpgradedSharedStore(store: Awaited<ReturnType<typeof createHistoricalSharedStore>>) {
  const reopened = openOpenClawAgentDatabase(store.options);
  expect(reopened.agentId).toBe("main");
  expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  expect(reopened.db.prepare("SELECT agent_id, schema_version FROM schema_meta").get()).toEqual({
    agent_id: "main",
    schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
  expect(loadExactSessionEntry(store.scope)?.entry.goal).toEqual(store.goalReceipt?.goal);
  expect(loadExactSessionEntry(store.scope)?.entry).toMatchObject({
    createdAt: 5,
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: "person", label: "Original creator" },
  });
  expect(readStoredGoalState(reopened.db, store.scope.sessionKey)).toEqual(store.goalState);
  expect(
    lookupSessionGoalOperation({
      ...store.scope,
      expectedSessionId: "doctor-session",
      operation: store.goalOperation,
    }),
  ).toEqual(store.goalReceipt);
  expect(listSessionParticipantsReadOnly(store.scope).get(store.scope.sessionKey)).toEqual([
    {
      identity: { type: "profile", id: "person" },
      contributionCount: 3,
      firstPromptedAt: store.schemaVersion === 17 ? null : 10,
      lastPromptedAt: store.schemaVersion === 17 ? null : 20,
    },
  ]);
  expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
}

describe("Doctor canonical session SQLite targets", () => {
  it.each([17, 18] as const)(
    "upgrades configured v%s shared history using its physical migration owner",
    async (schemaVersion) => {
      const store = await createHistoricalSharedStore(false, schemaVersion);
      const configuredAgentDatabaseTargets = resolveConfiguredAgentDatabaseTargets(store.cfg, {
        env: store.env,
      });
      expect(configuredAgentDatabaseTargets).toEqual([{ agentId: "main", path: store.sqlitePath }]);
      const migrated = await migrateLegacyMediaPersistence({
        configuredAgentDatabaseTargets,
        env: store.env,
      });
      expect(migrated).toEqual({
        changes: [
          `Upgraded agent database schema in ${store.sqlitePath}: v${schemaVersion} -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        ],
        warnings: [],
      });
      expect(
        await migrateLegacyMediaPersistence({ configuredAgentDatabaseTargets, env: store.env }),
      ).toEqual({ changes: [], warnings: [] });
      expectUpgradedSharedStore(store);
    },
  );

  it.each([
    {
      userVersion: 18,
      metadataVersion: 17,
      reason: "metadata schema version 17 does not match 18",
    },
    {
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
      metadataVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
      reason: "uses newer schema version",
    },
  ])(
    "refuses unsupported or mismatched schema markers $userVersion/$metadataVersion without rewriting history",
    async ({ userVersion, metadataVersion, reason }) => {
      const store = await createHistoricalSharedStore(false, 18);
      const database = openNodeSqliteDatabase(store.sqlitePath);
      database.exec(
        `PRAGMA user_version = ${userVersion}; UPDATE schema_meta SET schema_version = ${metadataVersion};`,
      );
      database.close();
      const before = fs.readFileSync(store.sqlitePath);
      const migrated = await migrateLegacyMediaPersistence({
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(store.cfg, {
          env: store.env,
        }),
        env: store.env,
      });
      expect(migrated.changes).toEqual([]);
      expect(migrated.warnings).toEqual([expect.stringContaining(reason)]);
      expect(fs.readFileSync(store.sqlitePath)).toEqual(before);
    },
  );

  it.each(["import-finalize", "recover"] as const)(
    "%s fences live writers before upgrading the physical shared owner",
    async (mode) => {
      const store = await createHistoricalSharedStore(mode === "recover");
      const before = fs.readFileSync(store.sqlitePath);
      // A real lease not attached to a cached handle survives maintenance's
      // local handle cleanup, just like another process's active writer.
      const lease = claimOpenClawAgentDatabaseLease({
        agentId: "main",
        path: store.sqlitePath,
        env: store.env,
      });
      try {
        const migrated = await migrateLegacyMediaPersistence({
          configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(store.cfg, {
            env: store.env,
          }),
          env: store.env,
        });
        expect(migrated.changes).toEqual([]);
        expect(migrated.warnings).toEqual([
          expect.stringMatching(
            /^Agent database maintenance deferred: .*stop that process and rerun openclaw doctor --fix/s,
          ),
        ]);
        await expect(repairHistoricalSharedStore(store, mode)).rejects.toThrow(
          /stop that process and rerun openclaw doctor --fix/,
        );
        expect(fs.readFileSync(store.sqlitePath)).toEqual(before);
      } finally {
        releaseOpenClawAgentDatabaseLease(lease, { env: store.env });
      }
      await repairHistoricalSharedStore(store, mode);
      expectUpgradedSharedStore(store);
      if (mode === "recover") {
        expect(
          openOpenClawAgentDatabase(store.options)
            .db.prepare("SELECT value_json FROM cache_entries WHERE scope = 'doctor'")
            .get(),
        ).toEqual({ value_json: '{"ok":true}' });
      }
    },
  );

  it("keeps shared data in place when participant dependencies refuse canonical-index recovery", async () => {
    const store = await createHistoricalSharedStore(true);
    const database = openNodeSqliteDatabase(store.sqlitePath);
    try {
      database.exec(
        "CREATE VIEW retained_participant_view AS SELECT actor_id FROM session_participants;",
      );
    } finally {
      database.close();
    }
    const report = await runDoctorSessionSqlite({
      cfg: store.cfg,
      env: store.env,
      allAgents: true,
      mode: "recover",
    });
    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining(
          "Participant migration cannot rebuild unknown indexes, views, or triggers",
        ),
      }),
    ]);
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(
      fs.readdirSync(path.dirname(store.sqlitePath)).some((file) => file.includes(".corrupt-")),
    ).toBe(false);
    const migrated = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(store.cfg, {
        env: store.env,
      }),
      env: store.env,
    });
    expect(migrated).toEqual({
      changes: [],
      warnings: [
        `Skipped agent database migration for ${store.sqlitePath}: Error: Participant migration cannot rebuild unknown indexes, views, or triggers.`,
      ],
    });
    const preserved = openNodeSqliteDatabase(store.sqlitePath, { readOnly: true });
    try {
      expect(readStoredGoalState(preserved, store.scope.sessionKey)).toEqual(store.goalState);
      expect(preserved.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
      expect(preserved.prepare("SELECT agent_id, schema_version FROM schema_meta").get()).toEqual({
        agent_id: "main",
        schema_version: 17,
      });
      expect(
        preserved
          .prepare(
            "SELECT actor_id, contribution_count, first_prompted_at, last_prompted_at FROM session_participants",
          )
          .all(),
      ).toEqual([
        { actor_id: "person", contribution_count: 3, first_prompted_at: 10, last_prompted_at: 20 },
      ]);
      expect(preserved.prepare("SELECT actor_id FROM retained_participant_view").all()).toEqual([
        { actor_id: "person" },
      ]);
      expect(
        preserved
          .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
          .get(store.scope.sessionKey),
      ).toEqual({ current_session_id: "doctor-session" });
    } finally {
      preserved.close();
    }
  });

  it.each(["dry-run", "import", "validate"] as const)(
    "%s never treats an exact SQLite database as a legacy file",
    async (mode) => {
      const store = await createStore("shared");
      const original = fs.readFileSync(store.sqlitePath);
      const report = await runDoctorSessionSqlite({
        cfg: store.cfg,
        env: store.env,
        allAgents: true,
        mode,
      });

      expect(report.targets).toEqual([]);
      expect(report.migrationRun).toBeUndefined();
      expect(fs.readFileSync(store.sqlitePath)).toEqual(original);
      expect(fs.existsSync(path.join(store.stateDir, "session-sqlite-migration-runs"))).toBe(false);
      expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
    },
  );

  it.each(["shared", "custom"] as const)(
    "inspects the %s SQLite database without a legacy session file",
    async (layout) => {
      const store = await createStore(layout);
      const report = await runDoctorSessionSqlite({
        cfg: store.cfg,
        env: store.env,
        allAgents: true,
        mode: "inspect",
      });

      expect(report.totals).toMatchObject({
        targets: 1,
        legacyEntries: 0,
        sqliteEntries: 1,
        issues: 0,
      });
      expect(report.targets[0]?.sqlitePath).toBe(store.sqlitePath);
      expect(report.targets[0]?.dbStats?.integrityCheck).toBe("ok");
      expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
      expect(openOpenClawAgentDatabase(store.options).agentId).toBe(
        layout === "shared" ? "main" : "qa",
      );
    },
  );

  it("includes the default SQLite target after its legacy file has been retired", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-doctor-default-store-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    await upsertSessionEntryCore(
      { agentId: "main", env, sessionKey: "agent:main:doctor" },
      { sessionId: "default-session", updatedAt: 1 },
    );
    const report = await runDoctorSessionSqlite({ cfg, env, mode: "inspect" });
    expect(report.totals).toMatchObject({
      targets: 1,
      legacyEntries: 0,
      sqliteEntries: 1,
      issues: 0,
    });
  });
});
