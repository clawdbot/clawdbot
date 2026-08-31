import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { historicalV17AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("same-version additive convergence before the v17 canonical guard", () => {
  it("migrates a v17 database that predates the route-context additive objects", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-historical-v17-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const { DatabaseSync } = requireNodeSqlite();
    const historical = new DatabaseSync(databasePath);
    try {
      historical.exec(historicalV17AgentSchemaSql());
      historical.exec("PRAGMA user_version = 17;");
      historical
        .prepare(
          `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', 17, 'main', '2026.8.1-beta.2', 1000, 1000)`,
        )
        .run();
      const entry = JSON.stringify({
        sessionId: "historical-v17",
        status: "done",
        updatedAt: 1000,
      });
      historical
        .prepare(
          `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
        )
        .run("agent:main:historical-v17", "historical-v17", entry, 1000, 1000);
      historical
        .prepare(
          `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v17')`,
        )
        .run("historical-v17", "agent:main:historical-v17", 1000, 1000);
      const event = {
        id: "event-v17",
        message: { content: "historical", role: "user" },
        parentId: null,
        timestamp: 1000,
        type: "message",
      };
      historical
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
        )
        .run("historical-v17", JSON.stringify(event), 1100);
      historical
        .prepare(
          `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
        )
        .run("historical-v17", "event-v17", 1100);
    } finally {
      historical.close();
    }
    registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 17 });

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining(
        `Upgraded agent database schema in ${databasePath}: v17 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      ),
    ]);
    closeOpenClawAgentDatabasesForTest();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated
          .prepare(
            "SELECT count(*) AS c FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toEqual({ c: 1 });
      expect(
        migrated
          .prepare(
            "SELECT count(*) AS c FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toEqual({ c: 1 });
      // The drifted index whose repair exposed the guard must exist again.
      expect(
        migrated
          .prepare(
            "SELECT count(*) AS c FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toEqual({ c: 1 });
    } finally {
      migrated.close();
    }
  });
});
