import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
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

describe("legacy media persistence Doctor migration from historical v15/v16", () => {
  it.each([15, 16])(
    "converges the exact shared physical schema from v%i through the current route",
    (schemaVersion) => {
      const historicalSchema = historicalV15AgentSchemaSql();
      expect(createHash("sha256").update(historicalSchema).digest("hex")).toBe(
        "75953ef97a738251822fc5aaf283bbe55fbcabe8702ad771892cdafc85d8e6b9",
      );

      const stateDir = makeTempDir(tempDirs, `media-persistence-historical-v${schemaVersion}-`);
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const sessionId = `historical-v${schemaVersion}`;
      const sessionKey = `agent:main:${sessionId}`;
      const mediaPath = `/media/v${schemaVersion}.png`;
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });

      const { DatabaseSync } = requireNodeSqlite();
      const historical = new DatabaseSync(databasePath);
      try {
        historical.exec(historicalSchema);
        historical.exec(`PRAGMA user_version = ${schemaVersion};`);
        historical
          .prepare(
            `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', ?, 'main', '2026.7.2', 1000, 1000)`,
          )
          .run(schemaVersion);
        historical
          .prepare(
            `INSERT INTO state_leases (
             scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
           ) VALUES ('retired', 'orphan', 'nobody', NULL, NULL, NULL, 1, 1)`,
          )
          .run();
        const entry = JSON.stringify({
          sessionId,
          status: "done",
          updatedAt: 1000,
        });
        historical
          .prepare(
            `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
          )
          .run(sessionKey, sessionId, entry, 1000, 1000);
        historical
          .prepare(
            `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v15')`,
          )
          .run(sessionId, sessionKey, 1000, 1000);
        const event = {
          id: `event-v${schemaVersion}`,
          message: { MediaPath: mediaPath, content: "historical", role: "user" },
          parentId: null,
          timestamp: 1000,
          type: "message",
        };
        historical
          .prepare(
            "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
          )
          .run(sessionId, JSON.stringify(event), 1100);
        historical
          .prepare(
            `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
          )
          .run(sessionId, event.id, 1100);
        expect(
          historical
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner') ORDER BY name",
            )
            .all(),
        ).toEqual([
          { type: "index", name: "idx_agent_state_leases_expiry" },
          { type: "index", name: "idx_agent_state_leases_owner" },
          { type: "table", name: "state_leases" },
        ]);
        expect(
          historical
            .prepare(
              "SELECT scope,lease_key,owner,expires_at,heartbeat_at,payload_json,created_at,updated_at FROM state_leases",
            )
            .get(),
        ).toEqual({
          scope: "retired",
          lease_key: "orphan",
          owner: "nobody",
          expires_at: null,
          heartbeat_at: null,
          payload_json: null,
          created_at: 1,
          updated_at: 1,
        });
      } finally {
        historical.close();
      }
      registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion });

      const result = migrateLegacyMediaPersistence({ env });
      expect(result.warnings).toEqual([]);

      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          migrated
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner')",
            )
            .all(),
        ).toEqual([]);
        expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        expect(
          migrated
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
        expect(
          migrated
            .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
            .get(sessionKey),
        ).toEqual({ entry_valid: 1 });
        expect(
          migrated.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
        ).toEqual({ main_key: "main" });
        const row = migrated
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
          .get(sessionId) as { event_json: string };
        const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> })
          .message;
        expect(message).not.toHaveProperty("MediaPath");
        expect(message).toMatchObject({
          content: "historical",
          role: "user",
          __openclaw: { media: [expect.objectContaining({ path: mediaPath })] },
        });
        expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        migrated.close();
      }

      expect(
        listOpenClawRegisteredAgentDatabases({
          env,
          includeIncompatibleSchemaVersions: true,
        }),
      ).toEqual([
        expect.objectContaining({
          agentId: "main",
          path: databasePath,
          schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        }),
      ]);
      expect(
        listSessionEntries({ agentId: "main", env }).map(({ entry, sessionKey: listedKey }) => ({
          sessionId: entry.sessionId,
          sessionKey: listedKey,
        })),
      ).toContainEqual({ sessionId, sessionKey });
      closeOpenClawAgentDatabasesForTest();
      expect(openOpenClawAgentDatabase({ agentId: "main", env }).db.isOpen).toBe(true);
      closeOpenClawAgentDatabasesForTest();
    },
  );
});
