// Memory Core tests cover shared agent database publication and shadow cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupAgedMemoryReindexTempFiles,
  publishMemoryDatabaseTables,
  readMemoryDatabaseRevision,
} from "./manager-db.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";

function ensureTestMemorySchema(db: DatabaseSync, cacheEnabled = true, ftsEnabled = false): void {
  ensureMemoryIndexSchema({
    db,
    cacheEnabled,
    ftsEnabled,
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toThrow("ENOENT");
}

describe("memory manager database publication", () => {
  let fixtureRoot = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-db-"));
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("removes a stale vector table when the shadow index has no vectors", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
      targetDb
        .prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)")
        .run("stale", "[]");
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_chunks_vec'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("publishes the canonical path FTS table and preserves its source triggers", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb, true, true);
      ensureTestMemorySchema(sourceDb, true, true);
      targetDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory/stale.md", "memory", "stale", 1, 1);
      targetDb.exec(`
        DROP TRIGGER memory_index_paths_fts_after_delete;
        CREATE TRIGGER memory_index_paths_fts_after_delete
        AFTER DELETE ON memory_index_sources
        BEGIN
          SELECT RAISE(ABORT, 'path FTS trigger fired during bulk publish');
        END;
      `);
      sourceDb
        .prepare(
          "INSERT INTO memory_index_sources (id, path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(42, "memory/replacement.md", "memory", "replacement", 2, 2);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "meta",
        expectedRevision,
      });

      expect(targetDb.prepare("SELECT path, source FROM memory_index_paths_fts").all()).toEqual([
        { path: "memory/replacement.md", source: "memory" },
      ]);
      expect(targetDb.prepare("SELECT id, path FROM memory_index_sources").all()).toEqual([
        { id: 42, path: "memory/replacement.md" },
      ]);
      expect(targetDb.prepare("SELECT rowid, path FROM memory_index_paths_fts").all()).toEqual([
        { rowid: 42, path: "memory/replacement.md" },
      ]);
      expect(
        targetDb
          .prepare("SELECT path FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ?")
          .all('"replacement"'),
      ).toEqual([{ path: "memory/replacement.md" }]);
      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_index_paths_fts_after_%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "memory_index_paths_fts_after_delete" },
        { name: "memory_index_paths_fts_after_insert" },
        { name: "memory_index_paths_fts_after_update" },
      ]);

      targetDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory/after-publish.md", "memory", "after", 3, 3);
      expect(
        targetDb
          .prepare("SELECT path FROM memory_index_paths_fts ORDER BY path")
          .all()
          .map((row) => (row as { path: string }).path),
      ).toEqual(["memory/after-publish.md", "memory/replacement.md"]);
      targetDb
        .prepare("UPDATE memory_index_sources SET path = ? WHERE path = ? AND source = ?")
        .run("memory/after-update.md", "memory/after-publish.md", "memory");
      targetDb
        .prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?")
        .run("memory/replacement.md", "memory");
      expect(targetDb.prepare("SELECT path FROM memory_index_paths_fts").all()).toEqual([
        { path: "memory/after-update.md" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("removes path FTS triggers when the shadow has FTS disabled", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb, true, true);
      ensureTestMemorySchema(sourceDb);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "meta",
        expectedRevision,
      });

      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_paths_fts'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_index_paths_fts_after_%'",
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        targetDb
          .prepare(
            "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
          )
          .run("memory/after-disabled-publish.md", "memory", "after", 1, 1),
      ).not.toThrow();
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("loads sqlite-vec on the target before publishing a shadow vector table", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath, { allowExtension: true });
    const sourceDb = new DatabaseSync(sourcePath, { allowExtension: true });
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      const sourceVector = await loadSqliteVecExtension({ db: sourceDb });
      if (!sourceVector.ok) {
        return;
      }
      sourceDb.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        )
      `);
      sourceDb
        .prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)")
        .run("vector", JSON.stringify([0, 1, 0]));
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
        vectorExtensionPath: sourceVector.extensionPath,
      });

      expect(targetDb.prepare("SELECT id FROM memory_index_chunks_vec").all()).toEqual([
        { id: "vector" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("rejects a stale shadow publish after a concurrent live memory update", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    let concurrentDb: DatabaseSync | undefined;
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory.md", "memory", "published", 1, 1);
      sourceDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory.md", "memory", "shadow", 1, 1);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      concurrentDb = new DatabaseSync(targetPath);
      concurrentDb
        .prepare("UPDATE memory_index_sources SET hash = ? WHERE path = ? AND source = ?")
        .run("newer", "memory.md", "memory");
      concurrentDb.close();
      concurrentDb = undefined;

      await expect(
        publishMemoryDatabaseTables({
          targetDb,
          sourcePath,
          metaKey: "memory_index_meta",
          expectedRevision,
        }),
      ).rejects.toThrow(/changed while full reindex was building/);
      expect(
        targetDb
          .prepare("SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?")
          .get("memory.md", "memory"),
      ).toEqual({ hash: "newer" });
    } finally {
      try {
        concurrentDb?.close();
      } catch {}
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("preserves the live embedding cache when the shadow index has caching disabled", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb, false);
      targetDb
        .prepare(
          `INSERT INTO memory_embedding_cache (
             provider, model, provider_key, hash, embedding, dims, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test", "model", "key", "hash", "[]", 0, 1);
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(targetDb.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "hash" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("removes aged orphan shadows but preserves young and locked shadows", async () => {
    const databasePath = path.join(fixtureRoot, "agent.sqlite");
    const database = new DatabaseSync(databasePath);
    database.close();
    const oldShadow = `${databasePath}.memory-reindex-11111111-2222-3333-4444-555555555555`;
    const youngShadow = `${databasePath}.memory-reindex-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const lockedShadow = `${databasePath}.memory-reindex-99999999-aaaa-bbbb-cccc-dddddddddddd`;
    const old = new Date(Date.now() - 48 * 60 * 60_000);

    for (const suffix of ["", "-wal", "-journal"]) {
      await fs.writeFile(`${oldShadow}${suffix}`, "orphan");
      await fs.utimes(`${oldShadow}${suffix}`, old, old);
    }
    await fs.writeFile(youngShadow, "active");
    await fs.writeFile(lockedShadow, "locked");
    await fs.utimes(lockedShadow, old, old);

    const lock = acquireMemoryReindexLock(databasePath);
    cleanupAgedMemoryReindexTempFiles(databasePath);
    await expect(fs.access(lockedShadow)).resolves.toBeUndefined();
    lock.release();

    cleanupAgedMemoryReindexTempFiles(databasePath);

    await expectPathMissing(oldShadow);
    await expectPathMissing(`${oldShadow}-wal`);
    await expectPathMissing(`${oldShadow}-journal`);
    await expectPathMissing(lockedShadow);
    await expect(fs.access(youngShadow)).resolves.toBeUndefined();
  });
});
