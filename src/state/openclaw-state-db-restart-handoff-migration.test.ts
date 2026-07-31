// Covers doctor repair of shipped fractional restart-handoff trace timestamps.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("gateway restart handoff state migration", () => {
  it("repairs fractional trace timestamps while doctor migrates version 2 to STRICT", () => {
    const stateDir = tempDirs.make("openclaw-state-restart-handoff-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    const strictCreateSql = (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'gateway_restart_handoff'",
        )
        .get() as { sql: string }
    ).sql;
    const flexibleCreateSql = strictCreateSql.replace(/\s+STRICT$/u, "");
    expect(flexibleCreateSql).not.toBe(strictCreateSql);
    legacy.exec(`
      DROP INDEX idx_gateway_restart_handoff_expiry;
      ALTER TABLE gateway_restart_handoff RENAME TO gateway_restart_handoff_strict;
      ${flexibleCreateSql};
      DROP TABLE gateway_restart_handoff_strict;
      PRAGMA user_version = 2;
      UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
    `);
    const now = Date.now();
    const insert = legacy.prepare(`
      INSERT INTO gateway_restart_handoff (
        handoff_key,
        kind,
        version,
        intent_id,
        pid,
        process_instance_id,
        created_at,
        expires_at,
        reason,
        restart_trace_started_at,
        restart_trace_last_at,
        source,
        restart_kind,
        supervisor_mode,
        updated_at_ms
      ) VALUES (?, 'gateway-supervisor-restart-handoff', 1, ?, 4242, ?, ?, ?,
                'update.run', ?, ?, 'gateway-update', 'update-process', 'systemd', ?)
    `);
    insert.run(
      "expired",
      "expired-intent",
      "expired-process",
      now - 120_000,
      now - 60_000,
      now - 130_000 + 0.9,
      now - 129_000 + 0.4,
      now,
    );
    insert.run(
      "current",
      "live-intent",
      "live-process",
      now - 1_000,
      now + 59_000,
      now - 5_000 + 0.9,
      now - 1_000 + 0.4,
      now,
    );
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "strict-tables-v3", path: databasePath },
      { kind: "session-watch-cursor-provenance-v4", path: databasePath },
    ]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated shared state session watch cursors → provenance column (0 ambient, 0 sentinels removed)",
        "Migrated shared state tables to SQLite STRICT typing (1)",
      ],
      warnings: [],
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'gateway_restart_handoff'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(
      migrated.db
        .prepare(
          `SELECT
             handoff_key,
             typeof(restart_trace_started_at) AS started_type,
             restart_trace_started_at,
             typeof(restart_trace_last_at) AS last_type,
             restart_trace_last_at
           FROM gateway_restart_handoff
           ORDER BY handoff_key`,
        )
        .all(),
    ).toEqual([
      {
        handoff_key: "current",
        started_type: "integer",
        restart_trace_started_at: Math.floor(now - 5_000 + 0.9),
        last_type: "integer",
        restart_trace_last_at: Math.floor(now - 1_000 + 0.4),
      },
    ]);
  });
});
