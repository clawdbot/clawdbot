import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
} from "./memory-recall-metadata.js";
import {
  ensureMemoryRecallMetadataSchema,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory recall metadata", () => {
  it("stores recall metadata in a rollback-safe additive table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE memory_index_chunks (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
          model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.exec("BEGIN IMMEDIATE");
      ensureMemoryRecallMetadataSchema(db);
      db.exec("ROLLBACK");
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE),
      ).toBeUndefined();

      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('memory_index_chunks') ORDER BY cid")
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
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, 'm', ?, '[]', 2)`,
      );
      const insertMetadata = db.prepare(
        `INSERT INTO ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE}
         (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)`,
      );

      insertChunk.run("good", "MEMORY.md", 1, 1, "h", "t");
      insertChunk.run("neutral", "MEMORY.md", 2, 2, "neutral", "neutral");
      expect(readMemoryRecallMetadata(db, ["neutral"]).get("neutral")).toEqual({
        id: "neutral",
        importance: null,
        triggers: null,
        project_key: null,
      });
      expect(() => insertMetadata.run("good", 11, null, null)).toThrow();
      insertMetadata.run("good", 9, "when flying", "github.com/openclaw/openclaw");
      expect(readMemoryRecallMetadata(db, ["good"]).get("good")).toEqual({
        id: "good",
        importance: 9,
        triggers: "when flying",
        project_key: "github.com/openclaw/openclaw",
      });
      expect(readCuratedMemoryTriggerCandidates(db, 10)).toEqual([
        {
          id: "good",
          path: "MEMORY.md",
          source: "memory",
          start_line: 1,
          end_line: 1,
          text: "t",
          importance: 9,
          triggers: "when flying",
          project_key: "github.com/openclaw/openclaw",
        },
      ]);

      for (let index = 0; index < 80; index += 1) {
        const id = `daily-${String(index).padStart(3, "0")}`;
        insertChunk.run(
          id,
          `memory/2026-07-${String(index + 1).padStart(3, "0")}.md`,
          1,
          1,
          id,
          "daily",
        );
        insertMetadata.run(id, null, null, "github.com/openclaw/openclaw");
      }
      expect(readCuratedProjectMemoryCandidates(db, 1, ["github.com/openclaw/openclaw"])).toEqual([
        expect.objectContaining({ id: "good", importance: 9 }),
      ]);

      for (let index = 0; index < 64; index += 1) {
        const id = `bootstrap-low-${String(index).padStart(3, "0")}`;
        insertChunk.run(id, "MEMORY.md", index + 2, index + 2, id, "low");
        insertMetadata.run(id, 1, null, "github.com/openclaw/openclaw");
      }
      insertChunk.run(
        "bootstrap-high",
        "MEMORY.md",
        100,
        100,
        "bootstrap-high",
        "high-priority bootstrap fact",
      );
      insertMetadata.run("bootstrap-high", 10, null, "github.com/openclaw/openclaw");
      expect(readCuratedProjectMemoryCandidates(db, 48, ["github.com/openclaw/openclaw"])).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "bootstrap-high", importance: 10 })]),
      );

      insertChunk.run("a-foreign", "MEMORY.md", 2, 2, "h2", "foreign");
      insertMetadata.run("a-foreign", 9, "when flying", "github.com/example/other");
      expect(readCuratedMemoryTriggerCandidates(db, 1, ["github.com/openclaw/openclaw"])).toEqual([
        expect.objectContaining({ id: "good" }),
      ]);
      expect(readCuratedMemoryTriggerCandidates(db, 1, [])).toEqual([]);

      insertChunk.run("a-fourth", "MEMORY.md", 3, 3, "h3", "fourth");
      insertMetadata.run("a-fourth", 8, "when flying", "project/d");
      expect(
        readCuratedMemoryTriggerCandidates(db, 1, [
          "project/a",
          "project/b",
          "project/c",
          "project/d",
        ])[0],
      ).toMatchObject({ id: "a-fourth", project_key: "project/d" });
    } finally {
      db.close();
    }
  });
});
