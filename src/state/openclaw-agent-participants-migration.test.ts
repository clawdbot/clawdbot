import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { describe, expect, it, vi } from "vitest";
import { compactDoctorSessionSqliteTarget } from "../commands/doctor-session-sqlite-compact.js";
import { recoverDoctorSessionSqliteTargets } from "../commands/doctor-session-sqlite-recover-report.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "./openclaw-agent-session-participants-schema.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
  normalizeSqliteSchemaShapeSql,
} from "./sqlite-schema-shape.test-support.js";

const sessionKey = "agent:main:participant-migration";

function readSessionEntryJson(database: DatabaseSync, key: string): string {
  const row = database
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(key) as { entry_json?: unknown } | undefined;
  if (typeof row?.entry_json !== "string") {
    throw new Error(`Missing session entry JSON for ${key}`);
  }
  return row.entry_json;
}

describe("participant identity migration", () => {
  it("rejects a missing aggregate count in the current schema", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const initial = openOpenClawAgentDatabase(options);
      initial.db.exec("ALTER TABLE session_participants DROP COLUMN contribution_count;");
      closeOpenClawAgentDatabasesForTest();
      expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_participants/);
    });
  });

  it("upgrades v17 during standalone import finalization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const databasePath = initial.path;
      initial.db.exec(
        "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
      );
      closeOpenClawAgentDatabasesForTest();
      const result = await compactDoctorSessionSqliteTarget(
        { agentId: "main", storePath: databasePath },
        { env: state.env, operation: "import-finalize" },
      );
      expect(result.skipped).toBe(false);
      const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
    });
  });

  it("repairs a v17 canonical index without quarantining the original database", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const databasePath = initial.path;
      initial.db.exec(`
        DROP TABLE session_participants;
        PRAGMA user_version = 17;
        UPDATE schema_meta SET schema_version = 17;
        INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
          VALUES ('participant-proof', 'preserved', '{"ok":true}', 100, 1);
        DROP INDEX idx_agent_cache_expiry;
        CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
      `);
      initial.db.enableDefensive?.(false);
      initial.db.exec(`PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry';
        PRAGMA writable_schema = OFF;`);
      const schemaVersion = initial.db.prepare("PRAGMA schema_version").get()?.schema_version;
      initial.db.exec(`PRAGMA schema_version = ${Number(schemaVersion) + 1};`);
      closeOpenClawAgentDatabasesForTest();
      const result = await recoverDoctorSessionSqliteTargets({
        env: state.env,
        options: { mode: "recover" },
        targets: [{ agentId: "main", storePath: databasePath }],
        validateTarget: async () => {
          throw new Error("Unexpected failed migration manifest");
        },
      });
      expect(result.targets[0]?.corruptRecovery).toBeUndefined();
      expect(result.totals.issues).toBe(0);
      const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          database
            .prepare("SELECT value_json FROM cache_entries WHERE scope = 'participant-proof'")
            .get(),
        ).toEqual({ value_json: '{"ok":true}' });
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        database.close();
      }
    });
  });

  it.each(["absent", "rollback", "unknown-column", "marker-mismatch"] as const)(
    "handles %s atomically",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey },
          { sessionId: "migration-session", updatedAt: 123 },
        );
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = initial.path;
        initial.db.exec(
          "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
        );
        if (scenario !== "absent") {
          initial.db.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
          initial.db
            .prepare(
              "INSERT INTO session_participants VALUES (?, 'human', 'profile', 'profile', 2, 30, 50)",
            )
            .run(sessionKey);
        }
        if (scenario === "unknown-column") {
          initial.db.exec("ALTER TABLE session_participants ADD COLUMN future INTEGER;");
        }
        if (scenario === "marker-mismatch") {
          initial.db.exec("UPDATE schema_meta SET schema_version = 16;");
        }
        closeOpenClawAgentDatabasesForTest();
        const database = openNodeSqliteDatabase(databasePath);
        const options = { agentId: "main", path: databasePath, env: state.env };
        const before = database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
        const exec = database.exec.bind(database);
        const injected = vi.spyOn(database, "exec").mockImplementation((sql) => {
          exec(sql);
          if (scenario === "rollback" && sql.includes("RENAME TO session_participants")) {
            throw new Error("injected after rebuild");
          }
        });
        try {
          const migration = withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
            ensureOpenClawAgentDatabaseSchema(database, options),
          );
          if (scenario === "absent") {
            await migration;
            expect(database.prepare("SELECT * FROM session_participants").all()).toEqual([]);
            expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
              OPENCLAW_AGENT_SCHEMA_VERSION,
            );
          } else {
            await expect(migration).rejects.toThrow(
              scenario === "rollback"
                ? /injected/
                : scenario === "marker-mismatch"
                  ? /markers disagree/
                  : /column definitions differ for session_participants/,
            );
            expect(
              database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
            ).toEqual(before);
            expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
            expect(
              database
                .prepare(
                  "SELECT actor_id, contribution_count, first_prompted_at, last_prompted_at FROM session_participants",
                )
                .all(),
            ).toEqual([
              {
                actor_id: "profile",
                contribution_count: 2,
                first_prompted_at: 30,
                last_prompted_at: 50,
              },
            ]);
          }
          expect(
            database
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'session_participants_identity_migration'",
              )
              .all(),
          ).toEqual([]);
          expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
          expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally {
          injected.mockRestore();
          database.close();
        }
      });
    },
  );
  it.each([0, 17])(
    "refuses a v%s identity migration outside stopped-writer maintenance",
    async (version) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = initial.path;
        initial.db.exec(
          `DROP TABLE session_participants; PRAGMA user_version = ${version}; UPDATE schema_meta SET schema_version = ${version};`,
        );
        closeOpenClawAgentDatabasesForTest();
        const database = openNodeSqliteDatabase(databasePath);
        try {
          expect(() =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              path: databasePath,
              env: state.env,
            }),
          ).toThrow(/maintenance/);
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        } finally {
          database.close();
        }
      });
    },
  );
  it("preserves supported non-profile observations and explicit unknown legacy identities", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId: "legacy-kinds", updatedAt: 1 },
      );
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const databasePath = initial.path;
      initial.db.exec("DROP TABLE session_participants;");
      initial.db.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
      const kinds = [
        {
          type: "agent",
          source: "agent",
          id: "helper",
          namespace: { type: "agent" },
          knownTime: true,
        },
        {
          type: "human",
          source: "channel",
          id: "same-id",
          namespace: { type: "legacy", actorType: "human", source: "channel" },
          knownTime: true,
        },
        {
          type: "human",
          source: null,
          id: "same-id-unknown",
          namespace: { type: "legacy", actorType: "human", source: null },
          knownTime: false,
        },
        {
          type: "human",
          source: "profile",
          id: "",
          namespace: { type: "legacy", actorType: "human", source: "profile" },
          knownTime: false,
        },
      ];
      for (const kind of kinds) {
        initial.db
          .prepare("INSERT INTO session_participants VALUES (?, ?, ?, ?, 2, 30, 50)")
          .run(sessionKey, kind.type, kind.id, kind.source);
      }
      initial.db.exec("PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;");
      closeOpenClawAgentDatabasesForTest();
      const database = openNodeSqliteDatabase(databasePath);
      try {
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            path: databasePath,
            env: state.env,
          }),
        );
        for (const kind of kinds) {
          expect(
            database.prepare("SELECT * FROM session_participants WHERE actor_id = ?").get(kind.id),
          ).toEqual({
            session_key: sessionKey,
            actor_id: kind.id,
            identity_namespace: JSON.stringify(kind.namespace),
            contribution_count: 2,
            first_prompted_at: kind.knownTime ? 30 : null,
            last_prompted_at: kind.knownTime ? 50 : null,
          });
        }
        expect(
          database.prepare("SELECT count(*) AS count FROM session_participants").get()?.count,
        ).toBe(kinds.length);
      } finally {
        database.close();
      }
    });
  });

  it.each(["original", "source", "count", "null-count"] as const)(
    "preserves membership but not unproved profile times from the %s shape",
    async (shape) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey },
          { sessionId: "migration-session", updatedAt: 123 },
        );
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = initial.path;
        initial.db.exec(`
          DROP TABLE session_participants;
          CREATE TABLE session_participants (
            session_key TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            ${shape !== "original" ? "actor_source TEXT," : ""}
            ${shape === "count" || shape === "null-count" ? "contribution_count INTEGER," : ""}
            first_prompted_at INTEGER NOT NULL,
            last_prompted_at INTEGER NOT NULL,
            PRIMARY KEY (session_key, actor_type, actor_id),
            FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
          ) STRICT;
          PRAGMA user_version = 17;
          UPDATE schema_meta SET schema_version = 17;
        `);
        initial.db
          .prepare(`INSERT INTO session_participants VALUES (
          ?, 'human', 'historical-profile',
          ${shape !== "original" ? "'profile'," : ""}
          ${shape === "count" ? "2," : shape === "null-count" ? "NULL," : ""}
          30, 50
        )`)
          .run(sessionKey);
        const originalEntry = initial.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey);
        closeOpenClawAgentDatabasesForTest();
        const database = openNodeSqliteDatabase(databasePath);
        try {
          const options = { agentId: "main", path: databasePath, env: state.env };
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
            ensureOpenClawAgentDatabaseSchema(database, options),
          );
          const rows = database.prepare("SELECT * FROM session_participants").all();
          expect(rows).toEqual([
            expect.objectContaining({
              identity_namespace:
                shape === "original"
                  ? JSON.stringify({ type: "legacy", actorType: "human", source: null })
                  : JSON.stringify({ type: "profile" }),
              actor_id: "historical-profile",
              contribution_count: shape === "count" ? 2 : 1,
              first_prompted_at: null,
              last_prompted_at: null,
            }),
          ]);
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          expect(
            database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
          ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
          expect(
            database
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get(sessionKey),
          ).toEqual(originalEntry);
          expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
          ensureOpenClawAgentDatabaseSchema(database, options);
          expect(database.prepare("SELECT * FROM session_participants").all()).toEqual(rows);
        } finally {
          database.close();
        }
      });
    },
  );

  it.each(["covenant", "upstream"] as const)(
    "converges the %s physical v18 lineage to the exact v19 schema",
    async (lineage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const validKey = `${sessionKey}:${lineage}:valid`;
        const malformedKey = `${sessionKey}:${lineage}:malformed`;
        const importedEpoch = "11111111-1111-4111-8111-111111111111";
        const retainedEpoch = "22222222-2222-4222-8222-222222222222";
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey: validKey },
          { sessionId: `${lineage}-valid`, updatedAt: 10 },
        );
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey: malformedKey },
          { sessionId: `${lineage}-malformed`, updatedAt: 20 },
        );
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = initial.path;
        const originalValidEntryJson = readSessionEntryJson(initial.db, validKey);
        const originalMalformedEntryJson = readSessionEntryJson(initial.db, malformedKey);
        if (lineage === "covenant") {
          initial.db.exec("DROP TABLE session_participants;");
          initial.db.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
          initial.db
            .prepare(
              `INSERT INTO session_participants (
                 session_key, actor_type, actor_id, actor_source,
                 contribution_count, first_prompted_at, last_prompted_at
               ) VALUES (?, 'human', 'profile-a', 'profile', 3, 30, 50)`,
            )
            .run(validKey);
          initial.db
            .prepare(
              `INSERT INTO session_recipient_authority (
                 session_key, epoch, created_at, updated_at
               ) VALUES (?, ?, 1, 1)`,
            )
            .run(validKey, retainedEpoch);
        } else {
          const validEntry = safeParseJsonRecord(originalValidEntryJson);
          const malformedEntry = safeParseJsonRecord(originalMalformedEntryJson);
          if (!validEntry || !malformedEntry) {
            throw new Error("Current session fixture contains malformed entry JSON");
          }
          initial.db
            .prepare(
              `INSERT INTO session_participants (
                 session_key, identity_namespace, actor_id, contribution_count,
                 first_prompted_at, last_prompted_at
               ) VALUES (?, '{"type":"profile"}', 'profile-a', 3, NULL, NULL)`,
            )
            .run(validKey);
          initial.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              ...validEntry,
              recipientAuthorityEpoch: importedEpoch,
            }),
            validKey,
          );
          initial.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              ...malformedEntry,
              recipientAuthorityEpoch: "not-an-epoch",
            }),
            malformedKey,
          );
          initial.db
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key IN (?, ?)")
            .run(validKey, malformedKey);
          initial.db.exec("DROP TABLE session_recipient_authority;");
        }
        initial.db.exec(`
          PRAGMA user_version = 18;
          UPDATE schema_meta SET schema_version = 18 WHERE meta_key = 'primary';
        `);
        closeOpenClawAgentDatabasesForTest();

        const database = openNodeSqliteDatabase(databasePath);
        const options = {
          agentId: "main",
          path: databasePath,
          env: state.env,
        };
        try {
          expect(() => ensureOpenClawAgentDatabaseSchema(database, options)).toThrow(
            /maintenance/iu,
          );
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(18);
          expect(
            database
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get()?.schema_version,
          ).toBe(18);

          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
            ensureOpenClawAgentDatabaseSchema(database, options),
          );

          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          expect(
            database
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get()?.schema_version,
          ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
          expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(database))).toEqual(
            normalizeSqliteSchemaShapeSql(
              createSqliteSchemaShapeFromSql(
                new URL("./openclaw-agent-schema.sql", import.meta.url),
              ),
            ),
          );
          expect(
            database
              .prepare(
                `SELECT identity_namespace, actor_id, contribution_count,
                        first_prompted_at, last_prompted_at
                 FROM session_participants
                 WHERE session_key = ?`,
              )
              .get(validKey),
          ).toEqual({
            identity_namespace: '{"type":"profile"}',
            actor_id: "profile-a",
            contribution_count: 3,
            first_prompted_at: null,
            last_prompted_at: null,
          });
          expect(
            database
              .prepare(
                "SELECT session_key, epoch FROM session_recipient_authority ORDER BY session_key",
              )
              .all(),
          ).toContainEqual({
            session_key: validKey,
            epoch: lineage === "covenant" ? retainedEpoch : importedEpoch,
          });
          expect(
            database
              .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
              .get(malformedKey),
          ).toBeUndefined();
          if (lineage === "upstream") {
            expect(
              database
                .prepare("SELECT entry_json, entry_valid FROM session_nodes WHERE session_key = ?")
                .get(validKey),
            ).toEqual({
              entry_json: originalValidEntryJson,
              entry_valid: 1,
            });
            expect(
              database
                .prepare("SELECT entry_json, entry_valid FROM session_nodes WHERE session_key = ?")
                .get(malformedKey),
            ).toEqual({
              entry_json: originalMalformedEntryJson,
              entry_valid: 1,
            });
          }
          expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally {
          database.close();
        }

        const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          reopened.db
            .prepare(
              "SELECT identity_namespace, contribution_count FROM session_participants WHERE session_key = ?",
            )
            .get(validKey),
        ).toEqual({ identity_namespace: '{"type":"profile"}', contribution_count: 3 });
        expect(
          reopened.db
            .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
            .get(validKey),
        ).toEqual({ epoch: lineage === "covenant" ? retainedEpoch : importedEpoch });
      });
    },
  );

  it("refuses disagreeing v18 markers before either physical migration", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const databasePath = initial.path;
      initial.db.exec(`
        DROP TABLE session_recipient_authority;
        PRAGMA user_version = 18;
        UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
      `);
      closeOpenClawAgentDatabasesForTest();
      const database = openNodeSqliteDatabase(databasePath);
      try {
        await expect(
          withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              path: databasePath,
              env: state.env,
            }),
          ),
        ).rejects.toThrow(/markers disagree/iu);
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(18);
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(17);
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_recipient_authority'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });
});
