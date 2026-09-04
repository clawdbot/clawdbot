import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

function createV17AdditiveFixture(
  options: { schemaDrift?: "missing-cache-table" | "participant-dependency" } = {},
) {
  const stateDir = makeTempDir(tempDirs, "media-persistence-v17-additive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TABLE session_participants;
    DROP TRIGGER session_conversations_route_context_invalidate_after_update;
    ALTER TABLE session_conversations DROP COLUMN route_context_json;
    DROP INDEX idx_agent_transcript_event_identity_sequence;
    PRAGMA user_version = 17;
    UPDATE schema_meta SET schema_version = 17;
  `);
  if (options.schemaDrift === "participant-dependency") {
    database.exec(`
      CREATE TABLE session_participants (
        session_key TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_source TEXT,
        contribution_count INTEGER,
        first_prompted_at INTEGER NOT NULL,
        last_prompted_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, actor_type, actor_id),
        FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_test_participant_dependency ON session_participants(actor_id);
    `);
  }
  if (options.schemaDrift === "missing-cache-table") {
    database.exec("DROP TABLE cache_entries;");
  }
  database.close();
  return { databasePath, env };
}

describe("legacy media persistence additive schema repair", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("repairs same-version additive session schema before media validation", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-current-additive-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db
      .prepare(
        `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "agent:main:session-1",
        "session-1",
        JSON.stringify({ sessionId: "session-1", updatedAt: 1 }),
        1,
      );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TRIGGER session_nodes_entry_valid_after_insert;
      DROP TRIGGER session_nodes_entry_valid_after_entry_update;
      DROP TRIGGER session_nodes_entry_valid_after_identity_update;
      DROP INDEX idx_agent_session_nodes_entry_valid_pending;
      DROP TABLE session_key_contract;
      ALTER TABLE session_nodes DROP COLUMN entry_valid;
    `);
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:session-1"),
      ).toEqual({ entry_valid: 1 });
      expect(
        repaired.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
    } finally {
      repaired.close();
    }
  });

  it("repairs v17 additive session schema before canonical index validation", async () => {
    const { databasePath, env } = createV17AdditiveFixture();
    const { DatabaseSync } = requireNodeSqlite();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toEqual({ name: "route_context_json" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toEqual({ name: "session_conversations_route_context_invalidate_after_update" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_transcript_event_identity_sequence" });
    } finally {
      repaired.close();
    }
  });

  it("rolls back v17 preflight repairs when identity migration rejects drift", async () => {
    const { databasePath, env } = createV17AdditiveFixture({
      schemaDrift: "participant-dependency",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "Participant migration cannot rebuild unknown indexes, views, or triggers",
    );
    closeOpenClawAgentDatabasesForTest();

    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(rolledBack.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        rolledBack
          .prepare("SELECT name FROM pragma_table_info('session_conversations') WHERE name = ?")
          .get("route_context_json"),
      ).toBeUndefined();
      expect(
        rolledBack
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
          .get("session_conversations_route_context_invalidate_after_update"),
      ).toBeUndefined();
      expect(
        rolledBack
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
          .get("idx_agent_transcript_event_identity_sequence"),
      ).toBeUndefined();
      expect(
        rolledBack
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
          .get("idx_test_participant_dependency"),
      ).toEqual({ name: "idx_test_participant_dependency" });
    } finally {
      rolledBack.close();
    }
  });

  it("keeps non-additive v17 schema drift rejected during index repair", async () => {
    const { databasePath, env } = createV17AdditiveFixture({
      schemaDrift: "missing-cache-table",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/missing table cache_entries/);
    const rejected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(rejected.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        rejected
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        rejected
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      rejected.close();
    }
  });
});
