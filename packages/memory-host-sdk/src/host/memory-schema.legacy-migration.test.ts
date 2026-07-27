// Same-file legacy migration tests cover conflict recovery and rollback boundaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory index same-file legacy migration", () => {
  it("leaves unrelated generic tables untouched", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, owner TEXT);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });

  it("recovers a partially migrated WAL index idempotently when legacy rows diverge", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-diverged-"));
    const dbPath = path.join(rootDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("PRAGMA journal_mode = WAL").get()).toEqual({ journal_mode: "wal" });
      ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', 'canonical');
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('doc.md', 'memory', 'new-hash', 200.0, 42);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-new-1', 'doc.md', 'memory', 1, 10, 'new-chunk-hash', 'model',
          'current canonical body', '[1,2]', 200
        );
        INSERT INTO memory_embedding_cache VALUES (
          'openai', 'model', 'key', 'new-chunk-hash', '[1,2]', 2, 200
        );
      `);
      // This is the partial migration state seen in affected databases: canonical
      // tables already contain current rows while the same file still has legacy tables.
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        CREATE TABLE embedding_cache (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          provider_key TEXT NOT NULL,
          hash TEXT NOT NULL,
          embedding TEXT NOT NULL,
          dims INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, model, provider_key, hash)
        );
        INSERT INTO meta VALUES ('memory_index_meta_v1', 'legacy');
        INSERT INTO meta VALUES ('legacy-only-key', 'imported');
        INSERT INTO files VALUES ('doc.md', 'memory', 'old-hash', 100, 40);
        INSERT INTO files VALUES ('old-note.md', 'memory', 'old-note-hash', 90, 10);
        INSERT INTO chunks VALUES (
          'chunk-new-1', 'doc.md', 'memory', 1, 8, 'old-chunk-hash', 'model',
          'same-key stale legacy body', '[9,9]', 100
        );
        INSERT INTO chunks VALUES (
          'chunk-old-7', 'doc.md', 'memory', 9, 12, 'old-tail-hash', 'model',
          'distinct stale legacy tail', '[8,8]', 100
        );
        INSERT INTO chunks VALUES (
          'chunk-old-2', 'old-note.md', 'memory', 1, 5, 'note-hash', 'model',
          'note body', '[]', 90
        );
        INSERT INTO embedding_cache VALUES (
          'openai', 'model', 'key', 'new-chunk-hash', '[9,9,9]', 3, 100
        );
        INSERT INTO embedding_cache VALUES (
          'openai', 'model', 'legacy-key', 'legacy-hash', '[3,4]', 2, 90
        );
      `);

      const readCanonicalState = () => ({
        meta: db.prepare("SELECT key, value FROM memory_index_meta ORDER BY key").all(),
        sources: db
          .prepare("SELECT path, hash, size FROM memory_index_sources ORDER BY path")
          .all(),
        chunks: db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
        cache: db
          .prepare(
            "SELECT provider_key, hash, embedding, dims, updated_at FROM memory_embedding_cache ORDER BY provider_key",
          )
          .all(),
      });
      const expectedCanonicalState = {
        meta: [
          { key: "legacy-only-key", value: "imported" },
          { key: "memory_index_meta_v1", value: "canonical" },
        ],
        // The extra legacy chunk identity makes doc.md's canonical chunk set
        // ambiguous. Its impossible hash forces a rebuild while preserving the
        // source identity needed to clean up a file deleted before migration.
        sources: [
          { path: "doc.md", hash: "", size: 42 },
          { path: "old-note.md", hash: "", size: 10 },
        ],
        chunks: [
          { id: "chunk-new-1", text: "current canonical body" },
          { id: "chunk-old-2", text: "note body" },
        ],
        cache: [
          {
            provider_key: "key",
            hash: "new-chunk-hash",
            embedding: "[1,2]",
            dims: 2,
            updated_at: 200,
          },
          {
            provider_key: "legacy-key",
            hash: "legacy-hash",
            embedding: "[3,4]",
            dims: 2,
            updated_at: 90,
          },
        ],
      };
      const readLegacyTables = () =>
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks', 'embedding_cache') ORDER BY name",
          )
          .all();

      expect(() =>
        ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false }),
      ).not.toThrow();
      expect(readCanonicalState()).toEqual(expectedCanonicalState);
      expect(readLegacyTables()).toEqual([]);

      expect(() =>
        ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false }),
      ).not.toThrow();
      expect(readCanonicalState()).toEqual(expectedCanonicalState);
      expect(readLegacyTables()).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rebuilds canonical FTS, rejects legacy orphans, and adopts canonical orphans", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('canonical.md', 'memory', 'canonical-hash', 200, 20);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-canonical', 'canonical.md', 'memory', 1, 2, 'canonical-chunk-hash',
          'fts-only', 'canonical nebula', '[]', 200
        );
        INSERT INTO memory_index_chunks VALUES (
          'chunk-canonical-ownerless', 'deleted.md', 'memory', 1, 2, 'orphan-chunk-hash',
          'fts-only', 'orphaned starlight', '[]', 190
        );
        INSERT INTO memory_index_chunks_fts
          (text, id, path, source, model, start_line, end_line)
        VALUES
          ('canonical nebula', 'chunk-canonical', 'canonical.md', 'memory', 'fts-only', 1, 2),
          ('orphaned starlight', 'chunk-canonical-ownerless', 'deleted.md', 'memory', 'fts-only', 1, 2);

        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        INSERT INTO files VALUES ('legacy.md', 'memory', 'legacy-hash', 100, 10);
        INSERT INTO chunks VALUES (
          'chunk-legacy', 'legacy.md', 'memory', 1, 2, 'legacy-chunk-hash',
          'fts-only', 'imported saffronquasar', '[]', 100
        );
        -- Shipped legacy cleanup could commit its source delete before deleting
        -- chunks. This derived orphan must not become canonical/searchable.
        INSERT INTO chunks VALUES (
          'chunk-ownerless', 'deleted.md', 'memory', 1, 2, 'orphan-chunk-hash',
          'fts-only', 'orphaned ambercomet', '[]', 90
        );
      `);

      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });

      expect(db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all()).toEqual([
        { id: "chunk-canonical" },
        { id: "chunk-canonical-ownerless" },
        { id: "chunk-legacy" },
      ]);
      expect(db.prepare("SELECT id FROM memory_index_chunks_fts ORDER BY id").all()).toEqual([
        { id: "chunk-canonical" },
        { id: "chunk-canonical-ownerless" },
        { id: "chunk-legacy" },
      ]);
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'saffronquasar'",
          )
          .all(),
      ).toEqual([{ id: "chunk-legacy" }]);
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'starlight'",
          )
          .all(),
      ).toEqual([{ id: "chunk-canonical-ownerless" }]);
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'ambercomet'",
          )
          .all(),
      ).toEqual([]);
      // Schema migration cannot write the runtime-owned sqlite-vec table. The
      // dirty source guarantees normal sync republishes every derived index.
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'legacy.md'").get(),
      ).toEqual({ hash: "" });
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'deleted.md'").get(),
      ).toEqual({ hash: "" });

      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts").get()).toEqual({
        count: 3,
      });
    } finally {
      db.close();
    }
  });

  it("keeps canonical chunk sets coherent and invalidates ambiguous partial sources", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        -- doc.md is already chunk-owned: its stale legacy chunk must not ride along.
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('doc.md', 'memory', 'doc-hash', 200.0, 42);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-doc-canonical', 'doc.md', 'memory', 1, 10, 'doc-chunk-hash', 'model',
          'canonical body', '[]', 200
        );
        -- partial.md has only the first canonical chunk. Seeing a second legacy
        -- identity makes completeness ambiguous, so the source must reindex.
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('partial.md', 'memory', 'partial-hash', 175.0, 30);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-partial-1', 'partial.md', 'memory', 1, 5, 'partial-1-hash', 'model',
          'canonical first half', '[]', 175
        );
        -- pending.md has a canonical source row but no chunks yet (indexing
        -- interrupted before its chunks were written): its legacy chunk is the
        -- only searchable content and must import instead of being stranded.
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('pending.md', 'memory', 'pending-hash', 150.0, 20);
        -- diverged.md is also chunkless, but its canonical metadata is newer;
        -- pairing its stale legacy chunks with that hash would wedge stale text.
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('diverged.md', 'memory', 'current-hash', 250.0, 30);
      `);
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        INSERT INTO files VALUES ('doc.md', 'memory', 'doc-hash', 200, 42);
        INSERT INTO files VALUES ('partial.md', 'memory', 'partial-hash', 175, 30);
        INSERT INTO files VALUES ('pending.md', 'memory', 'pending-hash', 150, 20);
        INSERT INTO files VALUES ('diverged.md', 'memory', 'stale-hash', 50, 12);
        INSERT INTO chunks VALUES (
          'chunk-doc-legacy', 'doc.md', 'memory', 1, 8, 'stale-hash', 'model',
          'stale legacy body', '[]', 100
        );
        INSERT INTO chunks VALUES (
          'chunk-partial-1', 'partial.md', 'memory', 1, 5, 'legacy-partial-1-hash', 'model',
          'legacy first half', '[]', 150
        );
        INSERT INTO chunks VALUES (
          'chunk-partial-2', 'partial.md', 'memory', 6, 10, 'partial-2-hash', 'model',
          'legacy second half', '[]', 150
        );
        INSERT INTO chunks VALUES (
          'chunk-pending-legacy', 'pending.md', 'memory', 1, 6, 'pending-chunk-hash', 'model',
          'only searchable content for pending', '[]', 150
        );
        INSERT INTO chunks VALUES (
          'chunk-diverged-legacy', 'diverged.md', 'memory', 1, 4, 'diverged-chunk-hash', 'model',
          'stale diverged content', '[]', 50
        );
      `);

      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });

      // doc.md keeps only its canonical chunk (stale legacy chunk excluded);
      // pending.md, whose canonical source had no chunks, imports its legacy
      // chunk so the file is not left silently unsearchable.
      expect(db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all()).toEqual([
        { id: "chunk-doc-canonical", text: "canonical body" },
        { id: "chunk-partial-1", text: "canonical first half" },
        { id: "chunk-pending-legacy", text: "only searchable content for pending" },
      ]);
      // An impossible hash prevents hash-based sync from skipping these rows,
      // while retaining the identities needed for deleted-file cleanup.
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'doc.md'").get(),
      ).toEqual({ hash: "" });
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'partial.md'").get(),
      ).toEqual({ hash: "" });
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'diverged.md'").get(),
      ).toEqual({ hash: "" });
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'pending.md'").get(),
      ).toEqual({ hash: "" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy tables when a chunk id belongs to a different canonical source", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('canonical.md', 'memory', 'canonical-hash', 200, 20);
        INSERT INTO memory_index_chunks VALUES (
          'shared-id', 'canonical.md', 'memory', 1, 2, 'canonical-chunk-hash', 'model',
          'canonical body', '[]', 200
        );
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        INSERT INTO files VALUES ('legacy.md', 'memory', 'legacy-hash', 100, 10);
        INSERT INTO chunks VALUES (
          'shared-id', 'legacy.md', 'memory', 1, 2, 'legacy-chunk-hash', 'model',
          'legacy body', '[]', 100
        );
      `);

      expect(() => ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toThrow(
        "legacy memory chunks rows could not be copied",
      );
      expect(db.prepare("SELECT path, text FROM memory_index_chunks").all()).toEqual([
        { path: "canonical.md", text: "canonical body" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy tables when legacy rows cannot be copied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        INSERT INTO files VALUES ('doc.md', 'memory', NULL, 1, 2);
        INSERT INTO chunks VALUES (
          'chunk-doc', 'doc.md', 'memory', 1, 2, 'chunk-hash', 'model',
          'body', '[]', 1
        );
      `);

      expect(() =>
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: false,
        }),
      ).toThrow("legacy memory files rows could not be copied");
      expect(db.prepare("SELECT path FROM files").get()).toEqual({ path: "doc.md" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy tables when legacy meta rows cannot be copied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        );
        INSERT INTO meta VALUES ('broken-key', NULL);
      `);

      expect(() =>
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: false,
        }),
      ).toThrow("legacy memory meta rows could not be copied");
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM memory_index_meta WHERE key = 'broken-key'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy tables when legacy chunk rows cannot be copied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO files VALUES ('note.md', 'memory', 'note-hash', 90, 10);
        -- Legacy-only source (canonical owns no chunks for it), so this chunk
        -- must copy; a NULL embedding makes it uncopyable under STRICT and the
        -- whole migration must abort with legacy tables retained.
        INSERT INTO chunks VALUES (
          'chunk-broken', 'note.md', 'memory', 1, 5, 'chunk-hash', 'model',
          'body', NULL, 90
        );
      `);

      expect(() =>
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: false,
        }),
      ).toThrow("legacy memory chunks rows could not be copied");
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });
});
