import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  AGENT_SCOPED_MEMORY_FTS_SHADOW_TABLES,
  AGENT_SCOPED_MEMORY_FTS_TABLE,
  AGENT_SCOPED_MEMORY_SCHEMA_SQL,
  AGENT_SCOPED_MEMORY_TABLES,
  ensureOpenClawAgentScopedMemorySchema,
} from "./openclaw-agent-scoped-memory-schema.js";

describe("scoped memory additive agent schema", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function createDatabase(): DatabaseSync {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    return database;
  }

  function tableNames(database: DatabaseSync): string[] {
    return (
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function expectScopedGroup(database: DatabaseSync): void {
    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        ...AGENT_SCOPED_MEMORY_TABLES,
        AGENT_SCOPED_MEMORY_FTS_TABLE,
        ...AGENT_SCOPED_MEMORY_FTS_SHADOW_TABLES,
      ]),
    );
  }

  it("leaves a current database compatible until first feature use", () => {
    const database = createDatabase();
    database.exec(OPENCLAW_AGENT_SCHEMA_SQL.replace(AGENT_SCOPED_MEMORY_SCHEMA_SQL, ""));

    expect(tableNames(database)).not.toContain("memory_storage_roots");
    expect(() =>
      assertOpenClawAgentSchemaContains(database, ":memory:", OPENCLAW_AGENT_SCHEMA_SQL),
    ).not.toThrow();

    ensureOpenClawAgentScopedMemorySchema(database);
    expectScopedGroup(database);
  });

  it("converges a partially interrupted group idempotently", () => {
    const database = createDatabase();
    const firstTableOnly = AGENT_SCOPED_MEMORY_SCHEMA_SQL.slice(
      0,
      AGENT_SCOPED_MEMORY_SCHEMA_SQL.indexOf("CREATE INDEX IF NOT EXISTS idx_memory_storage_roots"),
    );
    database.exec(firstTableOnly);
    expect(tableNames(database)).toContain("memory_storage_roots");
    expect(tableNames(database)).not.toContain("memory_stores");

    ensureOpenClawAgentScopedMemorySchema(database);
    ensureOpenClawAgentScopedMemorySchema(database);
    expectScopedGroup(database);
  });

  it("does not cache a rolled back transaction-local ensure", () => {
    const database = createDatabase();

    database.exec("BEGIN");
    ensureOpenClawAgentScopedMemorySchema(database);
    expect(tableNames(database)).toContain("memory_storage_roots");
    database.exec("ROLLBACK");
    expect(tableNames(database)).not.toContain("memory_storage_roots");

    ensureOpenClawAgentScopedMemorySchema(database);
    expectScopedGroup(database);
  });

  it("synchronizes scoped FTS without touching the legacy index tables", () => {
    const database = createDatabase();
    ensureOpenClawAgentScopedMemorySchema(database);
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        `INSERT INTO memory_scoped_chunks
          (chunk_id, revision_id, chunk_ordinal, start_line, end_line, text, content_hash, model, updated_at)
         VALUES (?, ?, 0, 1, 1, ?, ?, 'test', 1)`,
      )
      .run("chunk-1", "revision-1", "alpha token", "hash-1");

    expect(
      database
        .prepare(
          "SELECT chunk_id FROM memory_scoped_chunks_fts WHERE memory_scoped_chunks_fts MATCH ?",
        )
        .all('"alpha"'),
    ).toEqual([{ chunk_id: "chunk-1" }]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_index_chunks'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("installs immutable policy and transcript companion storage with the scoped group", () => {
    const database = createDatabase();
    ensureOpenClawAgentScopedMemorySchema(database);
    database
      .prepare(
        `INSERT INTO memory_policy_sets
          (policy_set_id, agent_id, memory_policy_revision, member_policy_set_ids_json, created_at)
         VALUES ('policy-set-1', 'main', 'policy-revision-1', '[]', 1)`,
      )
      .run();
    expect(() =>
      database
        .prepare(
          "UPDATE memory_policy_sets SET created_at = 2 WHERE policy_set_id = 'policy-set-1'",
        )
        .run(),
    ).toThrow(/immutable/u);
    const companionColumns = database
      .prepare(
        "SELECT name FROM pragma_table_info('transcript_event_memory_policies') ORDER BY cid",
      )
      .all() as Array<{ name: string }>;
    expect(companionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "authorization_status",
        "source_policy_set_id",
        "run_exposure_set_id",
        "session_identity_revision",
        "subject_revision",
      ]),
    );
  });

  it("keeps the pre-output exposure ledger in the canonical scoped schema payload", () => {
    expect(AGENT_SCOPED_MEMORY_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS memory_preoutput_exposure_ledger (",
    );
  });
});
