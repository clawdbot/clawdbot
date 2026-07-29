// Doctor memory schema tests exercise registered agent databases through the repair path.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { noteDoctorAgentMemorySchemaHealth } from "./doctor-agent-memory-schema.js";

const tempDirs: string[] = [];

function createRegisteredAgentDatabase(): {
  databasePath: string;
  env: NodeJS.ProcessEnv;
} {
  const stateDir = makeTempDir(tempDirs, "doctor-agent-memory-schema-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { databasePath, env };
}

function recreatePreProvenanceMemoryIndexChunks(databasePath: string): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE memory_index_chunk_provenance;
      DROP TABLE memory_index_chunks;
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO memory_index_chunks VALUES (
        'pre-provenance-sentinel', 'MEMORY.md', 'memory', 1, 2,
        'sentinel-hash', 'sentinel-model', 'sentinel text', '[1,0]', 42
      );
      CREATE TRIGGER memory_index_chunks_revision_after_insert
      AFTER INSERT ON memory_index_chunks
      BEGIN
        UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER memory_index_chunks_revision_after_update
      AFTER UPDATE ON memory_index_chunks
      BEGIN
        UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER memory_index_chunks_revision_after_delete
      AFTER DELETE ON memory_index_chunks
      BEGIN
        UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE INDEX idx_memory_index_chunks_path_source
        ON memory_index_chunks(path, source);
      CREATE INDEX idx_memory_index_chunks_path ON memory_index_chunks(path);
      CREATE INDEX idx_memory_index_chunks_source ON memory_index_chunks(source);
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function readMemoryChunkColumns(databasePath: string): string[] {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database
      .prepare("PRAGMA table_info(memory_index_chunks)")
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    database.close();
  }
}

function readMemoryChunkTableSql(databasePath: string): string {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'memory_index_chunks'",
      )
      .get() as { sql: string };
    return row.sql;
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("doctor agent memory schema repair", () => {
  it("adds recall metadata columns, preserves rows, and lists the durable repair", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreatePreProvenanceMemoryIndexChunks(databasePath);
    const writeNote = vi.fn();

    const report = await noteDoctorAgentMemorySchemaHealth(
      { env, shouldRepair: true },
      { note: writeNote },
    );

    expect(report).toEqual({
      repaired: [
        {
          agentId: "worker-1",
          columns: ["importance", "triggers"],
          path: databasePath,
        },
      ],
      warnings: [],
    });
    expect(writeNote).toHaveBeenCalledWith(
      expect.stringContaining(
        "Agent worker-1: added memory_index_chunks.importance, memory_index_chunks.triggers",
      ),
      "Doctor changes",
    );

    const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(readMemoryChunkColumns(databasePath)).toEqual([
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
        "importance",
        "triggers",
        "project_key",
      ]);
      expect(
        database
          .prepare("SELECT id, text, importance, triggers, project_key FROM memory_index_chunks")
          .get(),
      ).toEqual({
        id: "pre-provenance-sentinel",
        importance: null,
        project_key: null,
        text: "sentinel text",
        triggers: null,
      });
    } finally {
      database.close();
    }
  });

  it("is idempotent on a second doctor fix run", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreatePreProvenanceMemoryIndexChunks(databasePath);
    await noteDoctorAgentMemorySchemaHealth({ env, shouldRepair: true }, { note: vi.fn() });
    const writeNote = vi.fn();

    const report = await noteDoctorAgentMemorySchemaHealth(
      { env, shouldRepair: true },
      { note: writeNote },
    );

    expect(report).toEqual({ repaired: [], warnings: [] });
    expect(writeNote).not.toHaveBeenCalled();
  });

  it("leaves a fresh canonical database untouched", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    const beforeSql = readMemoryChunkTableSql(databasePath);
    const beforeStat = fs.statSync(databasePath);

    const report = await noteDoctorAgentMemorySchemaHealth(
      { env, shouldRepair: true },
      { note: vi.fn() },
    );

    const afterStat = fs.statSync(databasePath);
    expect(report).toEqual({ repaired: [], warnings: [] });
    expect(readMemoryChunkTableSql(databasePath)).toBe(beforeSql);
    expect({ mtimeMs: afterStat.mtimeMs, size: afterStat.size }).toEqual({
      mtimeMs: beforeStat.mtimeMs,
      size: beforeStat.size,
    });
  });

  it("continues canonical index maintenance on a pre-provenance database", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreatePreProvenanceMemoryIndexChunks(databasePath);
    const drifted = openNodeSqliteDatabase(databasePath);
    try {
      drifted.exec("DROP INDEX idx_agent_cache_updated;");
    } finally {
      drifted.close();
    }

    const report = await noteDoctorAgentMemorySchemaHealth(
      { env, shouldRepair: true },
      { note: vi.fn() },
    );

    expect(report.repaired).toHaveLength(1);
    const repaired = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_cache_updated'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_cache_updated" });
    } finally {
      repaired.close();
    }
  });
});
