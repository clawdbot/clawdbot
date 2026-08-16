// Memory FTS reconciliation keeps derived schemas aligned with canonical data.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory FTS schema reconciliation", () => {
  it("rebuilds body and path indexes when their tokenizer changes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: true,
          ftsTokenizer: "unicode61",
        }).ftsAvailable,
      ).toBe(true);
      db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('memory/needle.md', 'memory', 'source-hash', 1, 1);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('kept', 'memory/needle.md', 'memory', 1, 1, 'chunk-hash', 'model', 'needle body', '[]', 1);
        INSERT INTO memory_index_chunks_fts
          (text, id, path, source, model, start_line, end_line)
        VALUES ('needle body', 'kept', 'memory/needle.md', 'memory', 'model', 1, 1);
      `);

      expect(
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: true,
          ftsTokenizer: "trigram",
        }).ftsAvailable,
      ).toBe(true);

      const derivedSchemas = db
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('memory_index_chunks_fts', 'memory_index_paths_fts') ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(derivedSchemas).toHaveLength(2);
      expect(
        derivedSchemas.every((schema) =>
          schema.sql.includes("tokenize='trigram case_sensitive 0'"),
        ),
      ).toBe(true);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([
        { id: "kept", text: "needle body" },
      ]);
      expect(db.prepare("SELECT path, source FROM memory_index_paths_fts").all()).toEqual([
        { path: "memory/needle.md", source: "memory" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "kept", text: "needle body" },
      ]);
    } finally {
      db.close();
    }
  });

  it("repairs malformed derived tables without changing canonical rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('memory/kept.md', 'memory', 'source-hash', 1, 1);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('kept', 'memory/kept.md', 'memory', 1, 1, 'chunk-hash', 'model', 'kept body', '[]', 1);
        CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(wrong);
        CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(wrong);
        CREATE TRIGGER memory_index_paths_fts_after_insert
        AFTER INSERT ON memory_index_sources BEGIN SELECT 1; END;
      `);

      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([
        { id: "kept", text: "kept body" },
      ]);
      expect(db.prepare("SELECT path, source FROM memory_index_paths_fts").all()).toEqual([
        { path: "memory/kept.md", source: "memory" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "kept", text: "kept body" },
      ]);
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      ).run("memory/later.md", "memory", "later-hash", 2, 2);
      expect(db.prepare("SELECT path FROM memory_index_paths_fts ORDER BY path").all()).toEqual([
        { path: "memory/kept.md" },
        { path: "memory/later.md" },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: "indexed metadata columns",
      definition: "fts5(text, id, path, source, model, start_line, end_line)",
    },
    {
      name: "contentless storage",
      definition:
        "fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, content='')",
    },
  ])("repairs body indexes with $name", ({ definition }) => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('kept', 'memory/kept.md', 'memory', 1, 1, 'chunk-hash', 'model', 'kept body', '[]', 1);
        CREATE VIRTUAL TABLE memory_index_chunks_fts USING ${definition};
      `);

      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([
        { id: "kept", text: "kept body" },
      ]);
      expect(
        db
          .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
          .all("kept"),
      ).toEqual([{ id: "kept" }]);
      expect(
        db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'memory_index_chunks_fts'").get(),
      ).toEqual({
        sql: expect.stringContaining("id UNINDEXED"),
      });
    } finally {
      db.close();
    }
  });

  it.each(["memory_index_chunks", "MEMORY_INDEX_CHUNKS"])(
    "never drops canonical chunks for the colliding custom FTS table name %s",
    (ftsTable) => {
      const db = new DatabaseSync(":memory:");
      try {
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
        db.exec(`
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('kept', 'memory/kept.md', 'memory', 1, 1, 'chunk-hash', 'model', 'kept body', '[]', 1);
      `);

        expect(
          ensureMemoryIndexSchema({
            db,
            cacheEnabled: false,
            ftsEnabled: true,
            ftsTable,
          }).ftsAvailable,
        ).toBe(false);
        expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
          { id: "kept", text: "kept body" },
        ]);
      } finally {
        db.close();
      }
    },
  );

  it("never treats FTS-like text in an ordinary custom table as an FTS declaration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        CREATE TABLE custom_memory_fts (
          description TEXT NOT NULL DEFAULT 'USING fts5(text, id)'
        );
        INSERT INTO custom_memory_fts DEFAULT VALUES;
      `);

      expect(
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: true,
          ftsTable: "custom_memory_fts",
        }).ftsAvailable,
      ).toBe(false);
      expect(db.prepare("SELECT description FROM custom_memory_fts").all()).toEqual([
        { description: "USING fts5(text, id)" },
      ]);
    } finally {
      db.close();
    }
  });

  it.each(["memory_index_paths_fts", "MEMORY_INDEX_PATHS_FTS"])(
    "never replaces the reserved path FTS table through the custom body alias %s",
    (ftsTable) => {
      const db = new DatabaseSync(":memory:");
      try {
        expect(
          ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
        ).toBe(true);
        db.prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        ).run("memory/kept.md", "memory", "source-hash", 1, 1);

        expect(
          ensureMemoryIndexSchema({
            db,
            cacheEnabled: false,
            ftsEnabled: true,
            ftsTable,
          }).ftsAvailable,
        ).toBe(false);
        db.prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        ).run("memory/later.md", "memory", "later-hash", 2, 2);
        expect(db.prepare("SELECT path FROM memory_index_paths_fts ORDER BY path").all()).toEqual([
          { path: "memory/kept.md" },
          { path: "memory/later.md" },
        ]);
      } finally {
        db.close();
      }
    },
  );
});
