// Doctor memory schema tests exercise registered agent databases through the repair path.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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

function recreateUnreleasedInlineMemoryMetadata(databasePath: string): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE memory_index_chunk_recall_metadata;
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
        'pre-provenance-sentinel', 'MEMORY.md', 'memory', 1, 2,
        'sentinel-hash', 'sentinel-model', 'sentinel text', '[1,0]', 42,
        9, 'when testing rollback', 'project/key'
      );
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
  it.each([17, 18])(
    "moves v%s inline recall metadata, preserves rows, and lists the durable repair",
    async (version) => {
      const { databasePath, env } = createRegisteredAgentDatabase();
      recreateUnreleasedInlineMemoryMetadata(databasePath);
      if (version === 17) {
        const legacy = openNodeSqliteDatabase(databasePath);
        legacy.exec(
          "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
        );
        legacy.close();
      }
      const writeNote = vi.fn();

      const report = await noteDoctorAgentMemorySchemaHealth(
        { env, shouldRepair: true },
        { note: writeNote },
      );

      expect(report).toEqual({
        repaired: [
          {
            agentId: "worker-1",
            columns: ["importance", "triggers", "project_key"],
            path: databasePath,
            removedTrigger: true,
          },
        ],
        warnings: [],
      });
      expect(writeNote).toHaveBeenCalledWith(
        expect.stringContaining(
          "Agent worker-1: moved memory_index_chunks.importance, memory_index_chunks.triggers, memory_index_chunks.project_key to additive storage; removed memory_index_chunk_provenance_after_insert",
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
        ]);
        expect(database.prepare("SELECT id, text FROM memory_index_chunks").get()).toEqual({
          id: "pre-provenance-sentinel",
          text: "sentinel text",
        });
        expect(
          database
            .prepare(
              `SELECT importance, triggers, project_key
             FROM memory_index_chunk_recall_metadata
             WHERE chunk_id = 'pre-provenance-sentinel'`,
            )
            .get(),
        ).toEqual({
          importance: 9,
          project_key: "project/key",
          triggers: "when testing rollback",
        });
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
            )
            .get(),
        ).toBeUndefined();
        expect(
          database
            .prepare(
              "SELECT origin_class FROM memory_index_chunk_provenance WHERE chunk_id = 'pre-provenance-sentinel'",
            )
            .get(),
        ).toEqual({ origin_class: "agent" });
      } finally {
        database.close();
      }
    },
  );

  it("leaves a later runtime admission untouched after the first repair loses maintenance", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    const laterOptions = { agentId: "worker-2", env };
    const laterPath = openOpenClawAgentDatabase(laterOptions).path;
    closeOpenClawAgentDatabasesForTest();
    recreateUnreleasedInlineMemoryMetadata(databasePath);
    recreateUnreleasedInlineMemoryMetadata(laterPath);
    const agentDatabase = await import("../state/openclaw-agent-db.js");
    const integrityWorker = await import("../infra/sqlite-integrity-worker.js");
    const sqlite = await import("../infra/node-sqlite.js");
    const startAdmission = createDeferred();
    const admissionChecked = createDeferred();
    const releaseAdmission = createDeferred();
    // Register outside the old maintenance ALS scope: this is a new runtime owner.
    const newerAdmission = startAdmission.promise.then(() =>
      agentDatabase.withOpenClawAgentDatabaseAsync(laterOptions, (database) =>
        database.db.prepare("SELECT id, text FROM memory_index_chunks").all(),
      ),
    );
    void newerAdmission.catch(() => {});
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const scan = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        await check(...args);
        if (args[0] === laterPath) {
          // Keep the real pending admission alive before it converges the legacy shape.
          admissionChecked.resolve();
          await releaseAdmission.promise;
        }
      });
    const open = sqlite.openNodeSqliteDatabase;
    const inspectedPaths: string[] = [];
    const inspection = vi
      .spyOn(sqlite, "openNodeSqliteDatabase")
      .mockImplementation((pathname, options) => {
        if (options?.readOnly) {
          inspectedPaths.push(pathname);
        }
        return open(pathname, options);
      });
    const close = vi.spyOn(agentDatabase, "closeOpenClawAgentDatabaseByPath");
    const migrate = agentDatabase.migrateOpenClawAgentDatabaseForMaintenance;
    const repair = vi
      .spyOn(agentDatabase, "migrateOpenClawAgentDatabaseForMaintenance")
      .mockImplementationOnce(async (options, maintenance) => {
        await migrate(options, maintenance);
        const removed = openOpenClawStateDatabase({ env })
          .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
          .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        expect(removed.changes).toBe(1);
        // Earlier registry discovery may inspect targets while the lease is still valid.
        inspectedPaths.length = 0;
        close.mockClear();
        startAdmission.resolve();
        await Promise.race([admissionChecked.promise, newerAdmission]);
      });
    try {
      await expect(
        noteDoctorAgentMemorySchemaHealth({ env, shouldRepair: true }, { note: vi.fn() }),
      ).rejects.toThrow(/maintenance lease.*was lost/iu);
      expect(repair.mock.calls.map(([options]) => options.pathname)).toEqual([databasePath]);
      expect(inspectedPaths).not.toContain(laterPath);
      expect(close.mock.calls.some(([pathname]) => pathname === laterPath)).toBe(false);
      expect(scan.mock.calls.filter(([pathname]) => pathname === laterPath)).toHaveLength(1);
      releaseAdmission.resolve();
      await expect(newerAdmission).resolves.toEqual([
        { id: "pre-provenance-sentinel", text: "sentinel text" },
      ]);
    } finally {
      startAdmission.resolve();
      releaseAdmission.resolve();
      await newerAdmission.catch(() => {});
      repair.mockRestore();
      close.mockRestore();
      inspection.mockRestore();
      scan.mockRestore();
    }
  });

  it("is idempotent on a second doctor fix run", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreateUnreleasedInlineMemoryMetadata(databasePath);
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
    recreateUnreleasedInlineMemoryMetadata(databasePath);
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
