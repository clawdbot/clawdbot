// Memory Core tests cover deleted-file cleanup after same-file legacy migration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-runtime-mocks.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

describe("memory legacy migration cleanup", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let manager: MemoryIndexManager | undefined;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-migration-cleanup-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("removes migrated chunks and FTS rows when the dirty source file is already deleted", async () => {
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const seedDb = new DatabaseSync(dbPath, { allowExtension: true });
    let vectorExtensionPath: string | undefined;
    try {
      const loaded = await loadSqliteVecExtension({ db: seedDb });
      expect(loaded.ok, loaded.error).toBe(true);
      vectorExtensionPath = loaded.extensionPath;
      ensureMemoryIndexSchema({ db: seedDb, cacheEnabled: false, ftsEnabled: true });
      seedDb.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES
            ('memory/deleted.md', 'memory', 'canonical-hash', 200, 20),
            ('sessions/excluded.jsonl', 'sessions', '', 200, 20);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-canonical', 'memory/deleted.md', 'memory', 1, 2, 'canonical-chunk-hash',
          'fts-only', 'obsolete saffronquasar', '[]', 200
        );
        INSERT INTO memory_index_chunks VALUES (
          'chunk-ownerless', 'memory/ownerless.md', 'memory', 1, 2, 'ownerless-chunk-hash',
          'fts-only', 'obsolete ambercomet', '[]', 190
        );
        INSERT INTO memory_index_chunks_fts
          (text, id, path, source, model, start_line, end_line)
        VALUES
          (
            'obsolete saffronquasar', 'chunk-canonical', 'memory/deleted.md',
            'memory', 'fts-only', 1, 2
          ),
          (
            'obsolete ambercomet', 'chunk-ownerless', 'memory/ownerless.md',
            'memory', 'fts-only', 1, 2
          );
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        );
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-canonical', '[1,0,0]');
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-ownerless', '[0,1,0]');

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
        INSERT INTO files VALUES (
          'memory/deleted.md', 'memory', 'legacy-hash', 100, 10
        );
        INSERT INTO chunks VALUES (
          'chunk-legacy-extra', 'memory/deleted.md', 'memory', 3, 4, 'legacy-chunk-hash',
          'fts-only', 'stale legacy tail', '[]', 100
        );
      `);
      expect(seedDb.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual(
        { count: 2 },
      );
    } finally {
      seedDb.close();
    }

    const createConfig = (params: {
      extensionPath?: string;
      provider: "none" | "openai";
      vectorEnabled: boolean;
    }) =>
      ({
        memory: { backend: "builtin" },
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: params.provider,
              model: params.provider === "none" ? "" : "text-embedding-3-small",
              store: {
                vector: {
                  enabled: params.vectorEnabled,
                  ...(params.extensionPath ? { extensionPath: params.extensionPath } : {}),
                },
              },
              cache: { enabled: false },
              sync: { watch: false, onSessionStart: false, onSearch: false },
              query: { hybrid: { enabled: true } },
            },
          },
          list: [{ id: "main", default: true }],
        },
      }) as OpenClawConfig;
    const cfg = createConfig({ provider: "none", vectorEnabled: false });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "memory manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    expect(manager.status().fts?.available).toBe(true);
    expect(Reflect.get(manager, "sessionsFullRetryDirty")).toBe(false);

    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/deleted.md'").get(),
    ).toEqual({ hash: "" });
    expect(
      db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/ownerless.md'").get(),
    ).toEqual({ hash: "" });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 1 });

    await (
      manager as unknown as {
        syncMemoryFiles(params: { needsFullReindex: boolean }): Promise<unknown>;
      }
    ).syncMemoryFiles({ needsFullReindex: false });

    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    // Cleanup ran while vectors were disabled. Keep the old table untouched and
    // persist a rebuild marker; one-sided orphan pruning would still miss vector
    // rows that should exist but were never written.
    expect(
      db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
    const observerDb = new DatabaseSync(dbPath, { allowExtension: true });
    try {
      const observerLoaded = await loadSqliteVecExtension({
        db: observerDb,
        extensionPath: vectorExtensionPath,
      });
      expect(observerLoaded.ok, observerLoaded.error).toBe(true);
      expect(
        observerDb.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get(),
      ).toEqual({ count: 2 });
    } finally {
      observerDb.close();
    }
    await closeAllMemorySearchManagers();
    manager = undefined;

    const reloadResult = await getMemorySearchManager({
      cfg: createConfig({
        extensionPath: vectorExtensionPath,
        provider: "openai",
        vectorEnabled: true,
      }),
      agentId: "main",
    });
    if (!reloadResult.manager) {
      throw new Error(reloadResult.error ?? "reloaded memory manager missing");
    }
    manager = reloadResult.manager as unknown as MemoryIndexManager;
    const reloadedDb = Reflect.get(manager, "db") as DatabaseSync;
    await expect(
      (
        manager as unknown as {
          loadVectorExtension(): Promise<boolean>;
        }
      ).loadVectorExtension(),
    ).resolves.toBe(false);
    expect(reloadedDb.prepare("SELECT vec_version() AS version").get()).toEqual({
      version: expect.any(String),
    });
    expect(
      reloadedDb.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get(),
    ).toEqual({ count: 2 });
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });
});
