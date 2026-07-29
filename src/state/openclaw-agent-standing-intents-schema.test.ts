import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

const STANDING_SCHEMA_START = "CREATE TABLE IF NOT EXISTS standing_intents (";
const STANDING_SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_transcript_index_state (";
const PROVENANCE_SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_index_chunk_provenance (";
const PROVENANCE_SCHEMA_END = "CREATE TABLE IF NOT EXISTS memory_embedding_cache (";
const PROVENANCE_TRIGGER_START =
  "CREATE TRIGGER IF NOT EXISTS memory_index_chunk_provenance_after_insert";
const PROVENANCE_TRIGGER_END = "CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at";
const STANDING_CREATOR_COLUMN =
  "  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),\n";
const MEMORY_CHUNK_METADATA_COLUMNS =
  ",\n  importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),\n  triggers TEXT";

function removeSchemaSection(schema: string, startMarker: string, endMarker: string): string {
  const start = schema.indexOf(startMarker);
  const end = schema.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`schema markers missing in test fixture: ${startMarker}`);
  }
  return `${schema.slice(0, start)}${schema.slice(end)}`;
}

function schemaWithoutStandingIntents(): string {
  return removeSchemaSection(OPENCLAW_AGENT_SCHEMA_SQL, STANDING_SCHEMA_START, STANDING_SCHEMA_END);
}

function schemaWithoutMemoryProvenance(): string {
  const withoutTable = removeSchemaSection(
    OPENCLAW_AGENT_SCHEMA_SQL,
    PROVENANCE_SCHEMA_START,
    PROVENANCE_SCHEMA_END,
  );
  return removeSchemaSection(withoutTable, PROVENANCE_TRIGGER_START, PROVENANCE_TRIGGER_END);
}

function schemaWithoutStandingIntentCreator(): string {
  if (!OPENCLAW_AGENT_SCHEMA_SQL.includes(STANDING_CREATOR_COLUMN)) {
    throw new Error("standing-intent creator column missing in test fixture");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.replace(STANDING_CREATOR_COLUMN, "");
}

function schemaWithoutMemoryChunkMetadata(): string {
  if (!OPENCLAW_AGENT_SCHEMA_SQL.includes(MEMORY_CHUNK_METADATA_COLUMNS)) {
    throw new Error("memory chunk metadata columns missing in test fixture");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.replace(MEMORY_CHUNK_METADATA_COLUMNS, "");
}

describe("additive memory agent schemas", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a current-version database before the lazy ensure and ensures idempotently", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-intent-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutStandingIntents());
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      db.prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION);

      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: databasePath,
        }),
      ).not.toThrow();
      expect(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'standing_intents'").get(),
      ).toBeUndefined();

      ensureOpenClawAgentStandingIntentsSchema(db);
      ensureOpenClawAgentStandingIntentsSchema(db);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('standing_intents', 'standing_intents_fts') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toStrictEqual([
        "standing_intents",
        "standing_intents_fts",
      ]);
      const columns = db.prepare("PRAGMA table_info(standing_intents)").all() as Array<{
        name: string;
        pk: number;
        type: string;
      }>;
      expect(columns.find((column) => column.name === "intent_key")).toMatchObject({
        type: "INTEGER",
        pk: 1,
      });
      expect(columns.find((column) => column.name === "id")).toMatchObject({
        type: "TEXT",
        pk: 0,
      });
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("accepts current-version databases before the provenance lazy ensure", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provenance-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutMemoryProvenance());
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      db.prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION);

      db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: databasePath,
        }),
      ).toThrow(/missing or drifted trigger memory_index_chunk_provenance_after_insert/iu);
      db.exec(`DROP TABLE ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE};`);

      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: databasePath,
        }),
      ).not.toThrow();
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(MEMORY_INDEX_CHUNK_PROVENANCE_TABLE),
      ).toBeUndefined();

      db.exec("BEGIN IMMEDIATE");
      ensureMemoryChunkProvenance(db);
      db.exec("ROLLBACK");
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(MEMORY_INDEX_CHUNK_PROVENANCE_TABLE),
      ).toBeUndefined();

      ensureMemoryChunkProvenance(db);
      ensureMemoryChunkProvenance(db);

      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: databasePath,
        }),
      ).not.toThrow();

      expect(
        db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(MEMORY_INDEX_CHUNK_PROVENANCE_TABLE),
      ).toBeDefined();
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("lazily adds creator provenance to the unreleased standing-intent table", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-intent-creator-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutStandingIntentCreator());
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      db.prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION);

      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", path: databasePath }),
      ).not.toThrow();
      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('standing_intents')")
          .all()
          .map((row) => (row as { name: string }).name),
      ).not.toContain("creator_sender");

      ensureOpenClawAgentStandingIntentsSchema(db);
      ensureOpenClawAgentStandingIntentsSchema(db);

      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('standing_intents')")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toContain("creator_sender");
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", path: databasePath }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("accepts pre-provenance databases missing the memory chunk metadata columns", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chunk-metadata-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutMemoryChunkMetadata());
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      db.prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION);

      // Regression: shipped pre-provenance agent DBs must pass the canonical
      // check before memory-core's lazy ensure ALTERs the columns in, or every
      // existing deployment fails doctor and the updater rolls back.
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", path: databasePath }),
      ).not.toThrow();
      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('memory_index_chunks')")
          .all()
          .map((row) => (row as { name: string }).name),
      ).not.toContain("importance");
    } finally {
      db.close();
    }
  });
});
