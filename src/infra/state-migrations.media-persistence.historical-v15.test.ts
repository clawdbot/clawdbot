import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { historicalV15AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("legacy media persistence Doctor migration from historical v15", () => {
  it("converges the exact 509a5f0373764 schema before current-index repair", () => {
    const historicalSchema = historicalV15AgentSchemaSql();
    expect(createHash("sha256").update(historicalSchema).digest("hex")).toBe(
      "2ad94b064159086923e24acf4e11cb77546fca71646e7f49c7a6d40d2a22890a",
    );

    const stateDir = makeTempDir(tempDirs, "media-persistence-historical-v15-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const { DatabaseSync } = requireNodeSqlite();
    const historical = new DatabaseSync(databasePath);
    try {
      historical.exec(historicalSchema);
      historical.exec("PRAGMA user_version = 15;");
      historical
        .prepare(
          `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', 15, 'main', '2026.7.2', 1000, 1000)`,
        )
        .run();
      const entry = JSON.stringify({
        sessionId: "historical-v15",
        status: "done",
        updatedAt: 1000,
      });
      historical
        .prepare(
          `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
        )
        .run("agent:main:historical-v15", "historical-v15", entry, 1000, 1000);
      historical
        .prepare(
          `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v15')`,
        )
        .run("historical-v15", "agent:main:historical-v15", 1000, 1000);
      const event = {
        id: "event-v15",
        message: { MediaPath: "/media/v15.png", content: "historical", role: "user" },
        parentId: null,
        timestamp: 1000,
        type: "message",
      };
      historical
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
        )
        .run("historical-v15", JSON.stringify(event), 1100);
      historical
        .prepare(
          `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
        )
        .run("historical-v15", "event-v15", 1100);
    } finally {
      historical.close();
    }
    registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 15 });

    const result = migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(
      listSessionEntriesCore({ agentId: "main", env }).map(({ entry, sessionKey }) => ({
        sessionId: entry.sessionId,
        sessionKey,
      })),
    ).toContainEqual({
      sessionId: "historical-v15",
      sessionKey: "agent:main:historical-v15",
    });
    closeOpenClawAgentDatabasesForTest();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(
        migrated
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:historical-v15"),
      ).toEqual({ entry_valid: 1 });
      expect(
        migrated.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
      const row = migrated
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
        .get("historical-v15") as { event_json: string };
      const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
      expect(message).not.toHaveProperty("MediaPath");
      expect(message["__openclaw"]).toMatchObject({
        media: [expect.objectContaining({ path: "/media/v15.png" })],
      });
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});
