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

describe("legacy media persistence additive schema repair", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("accepts a current database whose receipt provenance is still lazy", () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-current-receipt-lazy-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec("ALTER TABLE conversation_deliveries DROP COLUMN platform_message_id_source;");
    database.close();

    expect(migrateLegacyMediaPersistence({ env }).warnings).toEqual([]);
    const validated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        (
          validated.prepare("PRAGMA table_info(conversation_deliveries)").all() as Array<{
            name?: unknown;
          }>
        ).some((column) => column.name === "platform_message_id_source"),
      ).toBe(false);
    } finally {
      validated.close();
    }
  });

  it("repairs same-version additive session schema before media validation", () => {
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

    const result = migrateLegacyMediaPersistence({ env });
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
});
