import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import { MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE } from "../../packages/memory-host-sdk/src/host/memory-schema-recall.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

const STANDING_SCHEMA_START = "CREATE TABLE IF NOT EXISTS standing_intents (";
const STANDING_SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_transcript_index_state (";
const PROVENANCE_SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_index_chunk_provenance (";
const PROVENANCE_SCHEMA_END = "CREATE TABLE IF NOT EXISTS memory_embedding_cache (";
const RECALL_METADATA_SCHEMA_START =
  "CREATE TABLE IF NOT EXISTS memory_index_chunk_recall_metadata (";
const RECALL_METADATA_SCHEMA_END = "CREATE TABLE IF NOT EXISTS memory_index_chunk_provenance (";
const STANDING_CREATOR_COLUMN =
  "  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),\n";

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
  return removeSchemaSection(
    OPENCLAW_AGENT_SCHEMA_SQL,
    PROVENANCE_SCHEMA_START,
    PROVENANCE_SCHEMA_END,
  );
}

function schemaWithoutStandingIntentCreator(): string {
  if (!OPENCLAW_AGENT_SCHEMA_SQL.includes(STANDING_CREATOR_COLUMN)) {
    throw new Error("standing-intent creator column missing in test fixture");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.replace(STANDING_CREATOR_COLUMN, "");
}

function schemaWithoutMemoryRecallMetadata(): string {
  return removeSchemaSection(
    OPENCLAW_AGENT_SCHEMA_SQL,
    RECALL_METADATA_SCHEMA_START,
    RECALL_METADATA_SCHEMA_END,
  );
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

  it("migrates unreleased inline chunk metadata into rollback-safe storage", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chunk-metadata-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutMemoryRecallMetadata());
      db.exec(`
        ALTER TABLE memory_index_chunks ADD COLUMN importance INTEGER
          CHECK (importance IS NULL OR importance BETWEEN 1 AND 10);
        ALTER TABLE memory_index_chunks ADD COLUMN triggers TEXT;
        ALTER TABLE memory_index_chunks ADD COLUMN project_key TEXT;
        CREATE TRIGGER memory_index_chunk_provenance_after_insert
        AFTER INSERT ON memory_index_chunks
        BEGIN
          INSERT OR IGNORE INTO memory_index_chunk_provenance (
            chunk_id, origin_class, session_kind, observed_at
          ) VALUES (NEW.id, 'agent', 'unknown', NEW.updated_at);
        END;
        INSERT INTO memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding,
          updated_at, importance, triggers, project_key
        ) VALUES (
          'sentinel', 'MEMORY.md', 'memory', 1, 1, 'hash', 'model', 'body', '[]',
          42, 9, 'when testing rollback', 'project/key'
        );
      `);
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
          .prepare("SELECT name FROM pragma_table_info('memory_index_chunks')")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual([
        "id",
        "path",
        "source",
        "start_line",
        "end_line",
        "hash",
        "model",
        "text",
        "embedding",
        "updated_at",
      ]);
      expect(
        db
          .prepare(
            `SELECT importance, triggers, project_key
             FROM ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE}
             WHERE chunk_id = 'sentinel'`,
          )
          .get(),
      ).toEqual({
        importance: 9,
        triggers: "when testing rollback",
        project_key: "project/key",
      });
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
          )
          .get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT origin_class FROM memory_index_chunk_provenance").get()).toEqual({
        origin_class: "agent",
      });
    } finally {
      db.close();
    }
  });
});
