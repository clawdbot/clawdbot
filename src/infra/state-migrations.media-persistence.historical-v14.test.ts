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
import { historicalV14AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("legacy media persistence Doctor migration from historical v14", () => {
  it("migrates a copy of the exact v2026.7.2-beta.4 schema without losing its session", () => {
    const historicalSchema = historicalV14AgentSchemaSql();
    expect(createHash("sha256").update(historicalSchema).digest("hex")).toBe(
      "955889668707fbccab70b80b5058af5a1587fd35ae32a80f8605179a68fb5117",
    );

    const stateDir = makeTempDir(tempDirs, "media-persistence-historical-v14-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const pristinePath = path.join(stateDir, "historical", "v14-pristine.sqlite");
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(pristinePath), { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const { DatabaseSync } = requireNodeSqlite();
    const pristine = new DatabaseSync(pristinePath);
    try {
      pristine.exec(historicalSchema);
      pristine.exec("PRAGMA user_version = 14;");
      pristine
        .prepare(
          `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', 14, 'main', '2026.7.2-beta.4', 1000, 1000)`,
        )
        .run();
      const entry = JSON.stringify({
        sessionId: "historical-v14",
        status: "done",
        updatedAt: 1000,
      });
      pristine
        .prepare(
          `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
        )
        .run("agent:main:historical-v14", "historical-v14", entry, 1000, 1000);
      pristine
        .prepare(
          `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v14')`,
        )
        .run("historical-v14", "agent:main:historical-v14", 1000, 1000);
      const event = {
        id: "event-v14",
        message: { MediaPath: "/media/v14.png", content: "historical", role: "user" },
        parentId: null,
        timestamp: 1000,
        type: "message",
      };
      pristine
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
        )
        .run("historical-v14", JSON.stringify(event), 1100);
      pristine
        .prepare(
          `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
        )
        .run("historical-v14", "event-v14", 1100);
    } finally {
      pristine.close();
    }
    const pristineHash = createHash("sha256").update(fs.readFileSync(pristinePath)).digest("hex");
    fs.copyFileSync(pristinePath, databasePath);
    registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 14 });

    const result = migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(
      listSessionEntriesCore({ agentId: "main", env }).map(({ entry, sessionKey }) => ({
        sessionId: entry.sessionId,
        sessionKey,
      })),
    ).toContainEqual({
      sessionId: "historical-v14",
      sessionKey: "agent:main:historical-v14",
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
          .get("agent:main:historical-v14"),
      ).toEqual({ entry_valid: 1 });
      expect(
        migrated.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
      const row = migrated
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
        .get("historical-v14") as { event_json: string };
      const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
      expect(message).not.toHaveProperty("MediaPath");
      expect(message["__openclaw"]).toMatchObject({
        media: [expect.objectContaining({ path: "/media/v14.png" })],
      });
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }

    expect(createHash("sha256").update(fs.readFileSync(pristinePath)).digest("hex")).toBe(
      pristineHash,
    );
    const original = new DatabaseSync(pristinePath, { readOnly: true });
    try {
      expect(original.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(
        original
          .prepare("SELECT name FROM pragma_table_info('session_nodes') WHERE name = 'entry_valid'")
          .get(),
      ).toBeUndefined();
    } finally {
      original.close();
    }
  });
});
