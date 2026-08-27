import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  listSessionParticipantsReadOnly,
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

async function createHistoricalSharedStore(corruptIndex = false) {
  const store = await createStore("shared");
  const database = openNodeSqliteDatabase(store.sqlitePath);
  try {
    // Restore the actual v17 table contract as well as both version markers;
    // header-only downgrades test refusal, not an ordinary supported upgrade.
    database.exec("DROP TABLE session_participants;");
    database.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
    database
      .prepare(
        "INSERT INTO session_participants VALUES (?, 'human', 'person', 'profile', 3, 10, 20)",
      )
      .run(store.scope.sessionKey);
    database.exec("PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;");
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
      const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
      database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
    }
  } finally {
    database.close();
  }
  return store;
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

function expectUpgradedSharedStore(store: Awaited<ReturnType<typeof createStore>>) {
  const reopened = openOpenClawAgentDatabase(store.options);
  expect(reopened.agentId).toBe("main");
  expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(18);
  expect(reopened.db.prepare("SELECT agent_id, schema_version FROM schema_meta").get()).toEqual({
    agent_id: "main",
    schema_version: 18,
  });
  expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
  expect(listSessionParticipantsReadOnly(store.scope).get(store.scope.sessionKey)).toEqual([
    {
      identity: { type: "profile", id: "person" },
      contributionCount: 3,
      firstPromptedAt: null,
      lastPromptedAt: null,
    },
  ]);
  expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
}

describe("Doctor canonical session SQLite targets", () => {
  it("upgrades configured shared history using its physical migration owner", async () => {
    const store = await createHistoricalSharedStore();
    const configuredAgentDatabaseTargets = resolveConfiguredAgentDatabaseTargets(store.cfg, {
      env: store.env,
    });
    expect(configuredAgentDatabaseTargets).toEqual([{ agentId: "main", path: store.sqlitePath }]);
    const migrated = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets,
      env: store.env,
    });
    expect(migrated.warnings).toEqual([]);
    expectUpgradedSharedStore(store);
  });

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
    const preserved = openNodeSqliteDatabase(store.sqlitePath, { readOnly: true });
    try {
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
