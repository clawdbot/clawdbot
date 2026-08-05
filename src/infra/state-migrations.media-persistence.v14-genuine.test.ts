// Doctor-route regression for #119263: a genuine v14 agent database predates
// the v15 session additions (entry_valid validity projection, session_key_contract
// table). The v14 migration path must install those additions before canonical
// index repair, or Doctor dies with "no such column: entry_valid". Kept in its
// own file because state-migrations.media-persistence.test.ts is at max-lines.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("legacy media persistence doctor migration from a genuine v14 database", () => {
  it("upgrades a genuine v14 database that lacks the v15 session additions", () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-v14-genuine-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();

    // A genuine v14 database predates the v15 session additions: no entry_valid
    // validity projection (column, triggers, pending index) and no
    // session_key_contract table. Canonical-index repair must not run before
    // these exist, or the migration dies with "no such column: entry_valid".
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = OFF;
        DROP TRIGGER IF EXISTS session_nodes_entry_valid_after_insert;
        DROP TRIGGER IF EXISTS session_nodes_entry_valid_after_entry_update;
        DROP TRIGGER IF EXISTS session_nodes_entry_valid_after_identity_update;
        DROP INDEX IF EXISTS idx_agent_session_nodes_entry_valid_pending;
        ALTER TABLE session_nodes DROP COLUMN entry_valid;
        DROP TABLE IF EXISTS session_key_contract;
        DROP TABLE IF EXISTS session_suggestions;
        PRAGMA user_version = 14;
        UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
      `);
      // Seed a v14 session: one node + window + transcript event carrying a
      // legacy MediaPath media reference.
      database
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("agent:main:legacy", "legacy", "{}", 1000);
      database
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("legacy", "agent:main:legacy", 1000, 1000);
      const event = {
        type: "message",
        id: "event-1",
        parentId: null,
        timestamp: 1000,
        message: { role: "user", content: "legacy", MediaPath: "/media/a.png" },
      };
      database
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("legacy", 0, JSON.stringify(event), 1100);
      database
        .prepare(
          "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("legacy", "event-1", 0, "message", null, null, 1100);
      reconcileSessionTranscriptIndexInTransaction(database, "legacy");
    } finally {
      database.close();
    }
    registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 14 });

    const result = migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      const nodeColumns = new Set(
        (after.prepare("PRAGMA table_info(session_nodes)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      expect(nodeColumns.has("entry_valid")).toBe(true);
      const tables = new Set(
        (
          after.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(tables.has("session_key_contract")).toBe(true);
      expect(tables.has("session_suggestions")).toBe(true);
      // The v14 session and its transcript survive the Doctor-route migration.
      expect(
        after
          .prepare(
            "SELECT current_session_id FROM session_nodes WHERE session_key = 'agent:main:legacy'",
          )
          .get(),
      ).toEqual({ current_session_id: "legacy" });
      expect(
        after.prepare("SELECT session_id FROM session_windows WHERE session_id = 'legacy'").get(),
      ).toEqual({ session_id: "legacy" });
      const row = after
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
        .get("legacy") as { event_json: string };
      const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
      expect(message).not.toHaveProperty("MediaPath");
      expect(message["__openclaw"]).toMatchObject({
        media: [expect.objectContaining({ path: "/media/a.png" })],
      });
    } finally {
      after.close();
    }
  });
});
