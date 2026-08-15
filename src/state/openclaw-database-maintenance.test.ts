import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
} from "./openclaw-state-db-additive-columns.js";
import {
  ensureAdditiveStateColumns,
  ensureDevicePairSetupBootstrapSchema,
  ensureWorkspaceRetentionSchema,
} from "./openclaw-state-db-schema-additive.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

describe("OpenClaw database maintenance schema validation", () => {
  it("accepts the current global and agent schemas", () => {
    const globalDatabase = createGlobalDatabase();
    const agentDatabase = createAgentDatabase();
    try {
      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(globalDatabase, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).not.toThrow();
    } finally {
      agentDatabase.close();
      globalDatabase.close();
    }
  });

  it("accepts a global schema produced by an additive column migration", () => {
    const schemaWithoutMigratedColumn = OPENCLAW_STATE_SCHEMA_SQL.replace(
      "  delivery_thread_id_type TEXT,\n",
      "",
    );
    const database = createGlobalDatabase(schemaWithoutMigratedColumn);
    try {
      database.exec("ALTER TABLE cron_jobs ADD COLUMN delivery_thread_id_type TEXT;");

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it.each([
    {
      current: "  removed_at INTEGER,\n  run_end_cleanup_json TEXT\n",
      previous: "  removed_at INTEGER\n",
    },
    {
      current: "  forced_abandonment_retained INTEGER,\n  created_at_ms INTEGER NOT NULL,\n",
      previous: "  created_at_ms INTEGER NOT NULL,\n",
    },
  ])(
    "keeps a newer nullable shared-state column compatible with the previous schema",
    ({ current, previous }) => {
      const previousSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(current, previous);
      const database = createGlobalDatabase();
      try {
        expect(previousSchema).not.toBe(OPENCLAW_STATE_SCHEMA_SQL);
        expect(() =>
          assertSqliteSchemaContains(database, "previous global schema", previousSchema, {
            allowCompatibleAdditiveColumns: true,
          }),
        ).not.toThrow();
      } finally {
        database.close();
      }
    },
  );

  it("keeps the cron authority companion table compatible with the previous schema", () => {
    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (",
    );
    const endMarker = "\n) STRICT;";
    const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const previousSchema = `${OPENCLAW_STATE_SCHEMA_SQL.slice(
      0,
      start,
    )}${OPENCLAW_STATE_SCHEMA_SQL.slice(end + endMarker.length)}`;
    const database = createGlobalDatabase();
    try {
      expect(() =>
        assertSqliteSchemaContains(database, "previous global schema", previousSchema),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts compatible future columns in shared-state and agent databases", () => {
    const globalDatabase = createGlobalDatabase();
    const agentDatabase = createAgentDatabase();
    try {
      globalDatabase.exec("ALTER TABLE worktrees ADD COLUMN future_note TEXT;");
      agentDatabase.exec("ALTER TABLE conversations ADD COLUMN future_note TEXT;");

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(globalDatabase, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).not.toThrow();
    } finally {
      agentDatabase.close();
      globalDatabase.close();
    }
  });

  it("accepts the historical checked shared-host column but rejects other constraints", () => {
    const historicalSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
      "  shared_host INTEGER\n) STRICT;",
      "  shared_host INTEGER CHECK (shared_host IN (0, 1))\n) STRICT;",
    );
    const database = createGlobalDatabase(historicalSchema);
    try {
      expect(historicalSchema).not.toBe(OPENCLAW_STATE_SCHEMA_SQL);
      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();

      database.exec("ALTER TABLE worktrees ADD COLUMN future_note TEXT DEFAULT NULL;");
      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).toThrow("column definitions differ for worktrees");
    } finally {
      database.close();
    }
  });

  it("keeps every same-version additive column bare and canonical", () => {
    const additiveColumns = CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(
      ({ columnName, tableName }) => `${tableName}.${columnName}`,
    );
    expect(OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingColumns).toEqual(
      additiveColumns,
    );
    expect(
      CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(
        ({ columnName, dataType, tableName }) => `${tableName}.${columnName} ${dataType}`,
      ),
    ).toEqual([
      "claw_installs.bootstrap_content_digest TEXT",
      "claw_installs.bootstrap_source_path TEXT",
      "worker_environments.desktop_json TEXT",
      "worker_environments.bootstrap_install_kind TEXT",
      "claw_package_refs.extension_adapter_identity TEXT",
      "claw_package_refs.extension_detected_format TEXT",
      "claw_package_refs.extension_format TEXT",
      "claw_package_refs.extension_id TEXT",
      "claw_package_refs.extension_mapped_json TEXT",
      "claw_package_refs.extension_unavailable_json TEXT",
      "worker_environments.shared_host INTEGER",
      "worker_session_placements.terminal_reason TEXT",
      "worker_session_placements.terminal_at_ms INTEGER",
      "worker_workspace_reconciliations.forced_abandonment_retained INTEGER",
      "worktrees.run_end_cleanup_json TEXT",
      "device_bootstrap_tokens.setup_id TEXT",
      "session_groups.cwd TEXT",
      "session_groups.worktree INTEGER",
      "installed_plugin_index.workspace_dir TEXT",
      "secret_store_entries.allowed_hosts TEXT",
    ]);

    const database = createGlobalDatabase();
    try {
      for (const {
        columnName,
        dataType,
        tableName,
      } of CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
        expect(readColumnContract(database, tableName, columnName)).toEqual({
          dflt_value: null,
          hidden: 0,
          name: columnName,
          notnull: 0,
          pk: 0,
          type: dataType,
        });
        database.exec(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}";`);
      }

      ensureAdditiveStateColumns(database);
      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
      for (const {
        columnName,
        dataType,
        tableName,
      } of CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
        expect(readColumnContract(database, tableName, columnName)).toEqual({
          dflt_value: null,
          hidden: 0,
          name: columnName,
          notnull: 0,
          pk: 0,
          type: dataType,
        });
      }
      for (const { columnName, tableName } of CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
        expect(readColumnContract(database, tableName, columnName)).toBeUndefined();
      }

      ensureDevicePairSetupBootstrapSchema(database);
      ensureWorkspaceRetentionSchema(database);
      for (const {
        columnName,
        dataType,
        tableName,
      } of CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
        expect(readColumnContract(database, tableName, columnName)).toEqual({
          dflt_value: null,
          hidden: 0,
          name: columnName,
          notnull: 0,
          pk: 0,
          type: dataType,
        });
      }
    } finally {
      database.close();
    }
  });

  it("accepts a migrated required column with its temporary default", () => {
    const schemaWithoutMigratedColumn = OPENCLAW_STATE_SCHEMA_SQL.replace(
      "  owner_session_key TEXT,\n  name TEXT NOT NULL,\n  description TEXT,\n",
      "  owner_session_key TEXT,\n  description TEXT,\n",
    );
    const database = createGlobalDatabase(schemaWithoutMigratedColumn);
    try {
      database.exec("ALTER TABLE cron_jobs ADD COLUMN name TEXT NOT NULL DEFAULT '';");

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts the migrated conversation kind with its temporary default", () => {
    const schemaWithoutMigratedColumn = OPENCLAW_STATE_SCHEMA_SQL.replace(
      "  conversation_kind TEXT NOT NULL,\n",
      "",
    ).replace(
      `CREATE INDEX IF NOT EXISTS idx_current_conversation_bindings_conversation
  ON current_conversation_bindings(channel, account_id, conversation_kind, conversation_id);
`,
      "",
    );
    const database = createGlobalDatabase(schemaWithoutMigratedColumn);
    try {
      database.exec(`
        ALTER TABLE current_conversation_bindings
          ADD COLUMN conversation_kind TEXT NOT NULL DEFAULT 'channel';
        CREATE INDEX idx_current_conversation_bindings_conversation
          ON current_conversation_bindings(channel, account_id, conversation_kind, conversation_id);
      `);

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects a current global database with a missing canonical table", () => {
    const database = createGlobalDatabase();
    try {
      database.exec("DROP TABLE delivery_queue_entries;");

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).toThrow("missing table delivery_queue_entries");
    } finally {
      database.close();
    }
  });

  it("rejects a current global database with a drifted canonical index", () => {
    const database = createGlobalDatabase();
    try {
      database.exec(`
        DROP INDEX idx_task_runs_status;
        CREATE INDEX idx_task_runs_status ON task_runs(task_id);
      `);

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).toThrow("missing or drifted index idx_task_runs_status");
    } finally {
      database.close();
    }
  });

  it("rejects a current global database with an unexpected unique index", () => {
    const database = createGlobalDatabase();
    try {
      database.exec("CREATE UNIQUE INDEX idx_task_runs_unexpected_owner ON task_runs(owner_key);");

      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname: "global.sqlite",
        }),
      ).toThrow("unexpected unique index idx_task_runs_unexpected_owner");
    } finally {
      database.close();
    }
  });

  it.each(["node_worker_launches", "worker_environment_ssh_fallback_ports"])(
    "allows lazy table %s to be absent but rejects drift",
    (tableName) => {
      const database = createGlobalDatabase();
      try {
        const canonicalTable = database
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName) as { sql?: unknown } | undefined;
        if (typeof canonicalTable?.sql !== "string") {
          throw new Error(`missing canonical ${tableName} table`);
        }
        database.exec(`DROP TABLE ${tableName};`);

        expect(() =>
          assertOpenClawStateDatabaseForMaintenance(database, {
            pathname: "global.sqlite",
          }),
        ).not.toThrow();

        const driftedTableSql = canonicalTable.sql.replace("(\n", "(\n  unexpected TEXT,\n");
        expect(driftedTableSql).not.toBe(canonicalTable.sql);
        database.exec(driftedTableSql);

        expect(() =>
          assertOpenClawStateDatabaseForMaintenance(database, {
            pathname: "global.sqlite",
          }),
        ).toThrow(`column definitions differ for ${tableName}`);
      } finally {
        database.close();
      }
    },
  );

  it("rejects a current agent database with a missing canonical table", () => {
    const database = createAgentDatabase();
    try {
      database.exec("DROP TABLE auth_profile_store;");

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("missing table auth_profile_store");
    } finally {
      database.close();
    }
  });

  it("accepts only canonical memory path FTS triggers", () => {
    const database = createAgentDatabase();
    try {
      ensureMemoryIndexSchema({
        db: database,
        cacheEnabled: true,
        ftsEnabled: true,
      });

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).not.toThrow();

      database.exec("DROP TRIGGER memory_index_paths_fts_after_delete;");
      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("missing or drifted trigger memory_index_paths_fts_after_delete");
      ensureMemoryIndexSchema({
        db: database,
        cacheEnabled: true,
        ftsEnabled: true,
      });

      database.exec(`
        CREATE TRIGGER memory_index_sources_unexpected_after_insert
        AFTER INSERT ON memory_index_sources
        BEGIN
          UPDATE memory_index_state SET revision = revision + 100 WHERE id = 1;
        END;
      `);

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("unexpected trigger memory_index_sources_unexpected_after_insert");
    } finally {
      database.close();
    }
  });

  it("rejects a drifted canonical memory path FTS trigger", () => {
    const database = createAgentDatabase();
    try {
      ensureMemoryIndexSchema({
        db: database,
        cacheEnabled: true,
        ftsEnabled: true,
      });
      database.exec(`
        DROP TRIGGER memory_index_paths_fts_after_insert;
        CREATE TRIGGER memory_index_paths_fts_after_insert
        AFTER INSERT ON memory_index_sources
        BEGIN
          INSERT INTO memory_index_paths_fts (rowid, path, source)
          VALUES (NEW.id, NEW.path || '-drifted', NEW.source);
        END;
      `);

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("missing or drifted trigger memory_index_paths_fts_after_insert");
    } finally {
      database.close();
    }
  });

  it("rejects a current agent database with a drifted canonical trigger", () => {
    const database = createAgentDatabase();
    try {
      database.exec(`
        DROP TRIGGER memory_index_sources_revision_after_insert;
        CREATE TRIGGER memory_index_sources_revision_after_insert
        AFTER INSERT ON memory_index_sources
        BEGIN
          UPDATE memory_index_state SET revision = 0 WHERE id = 1;
        END;
      `);

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("missing or drifted trigger memory_index_sources_revision_after_insert");
    } finally {
      database.close();
    }
  });

  it("rejects a current agent database with a missing canonical check constraint", () => {
    const database = createAgentDatabase();
    try {
      database.exec(`
        DROP TABLE memory_index_state;
        CREATE TABLE memory_index_state (
          id INTEGER PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        INSERT INTO memory_index_state (id, revision) VALUES (1, 0);
      `);

      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).toThrow("column definitions differ for memory_index_state");
    } finally {
      database.close();
    }
  });
});

function createGlobalDatabase(schemaSql = OPENCLAW_STATE_SCHEMA_SQL): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  database
    .prepare(
      `
        INSERT INTO schema_meta (
          meta_key,
          role,
          schema_version,
          agent_id,
          app_version,
          created_at,
          updated_at
        ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)
      `,
    )
    .run(OPENCLAW_STATE_SCHEMA_VERSION);
  return database;
}

function createAgentDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  database
    .prepare(
      `
        INSERT INTO schema_meta (
          meta_key,
          role,
          schema_version,
          agent_id,
          app_version,
          created_at,
          updated_at
        ) VALUES ('primary', 'agent', ?, 'worker-1', NULL, 1, 1)
      `,
    )
    .run(OPENCLAW_AGENT_SCHEMA_VERSION);
  return database;
}

function readColumnContract(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
): Record<string, unknown> | undefined {
  const column = (
    database.prepare(`PRAGMA table_xinfo("${tableName}")`).all() as Array<Record<string, unknown>>
  ).find((candidate) => candidate.name === columnName);
  return column
    ? {
        dflt_value: column.dflt_value,
        hidden: column.hidden,
        name: column.name,
        notnull: column.notnull,
        pk: column.pk,
        type: column.type,
      }
    : undefined;
}
