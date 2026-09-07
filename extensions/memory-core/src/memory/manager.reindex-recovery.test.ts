// Memory Core tests cover manager reindex recovery plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { resetMemoryDatabase } from "./manager-db.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type SyncArchiveParams = { needsFullReindex: boolean; targetArchiveFiles?: string[] };

type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runInPlaceReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
  syncArchiveFiles: (params: SyncArchiveParams) => Promise<unknown>;
  db: DatabaseSync;
  cache: { enabled: boolean; maxEntries?: number };
  writeMeta: (meta: MemoryIndexMeta) => void;
  providerKey: string | null;
  provider: EmbeddingProvider | null;
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
};

describe("memory manager reindex recovery", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    // Register the fixture at the same boundary used by config and provider creation.
    registerEmbeddingProvider({
      id: "openai",
      transport: "remote",
      create: async () => ({
        provider: {
          id: "openai",
          model: "mock-embed",
          maxInputTokens: 8192,
          embed: async () => [0, 1, 0],
          embedBatch: async (inputs) => inputs.map(() => [0, 1, 0]),
        },
      }),
    });
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-reindex-recovery-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (manager) {
      await manager.close();
      manager = null;
    }
    const { closeAllMemorySearchManagers } = await import("./index.js");
    await closeAllMemorySearchManagers();
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createCfg(params: {
    provider?: string;
    sources?: Array<"memory" | "sessions">;
    cacheEnabled?: boolean;
  }): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: params.provider ?? "openai",
          model: "mock-embed",
          store: { vector: {} },
          cache: { enabled: params.cacheEnabled ?? false },
          sources: params.sources,
          rememberAcrossConversations: params.sources?.includes("sessions") ?? false,
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    });
  }

  async function openManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
      throw new Error("manager does not support sync");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("restores retry state after a shadow full reindex fails late", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
      }),
    );
    const harness = memoryManager as unknown as ReindexHarness;
    const dirtySessionFile = path.join(workspaceDir, "sessions", "dirty.jsonl");
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };

    harness.dirty = true;
    harness.sessionsDirty = true;
    harness.sessionsDirtyFiles.add(dirtySessionFile);
    harness.syncMemoryFiles = async () => emptySyncPlan;
    harness.syncArchiveFiles = async () => emptySyncPlan;
    harness.writeMeta = () => {
      throw new Error("late reindex failure");
    };

    await expect(memoryManager.sync({ reason: "test", force: true })).rejects.toThrow(
      "late reindex failure",
    );

    expect(harness.dirty).toBe(true);
    expect(harness.memoryFullRetryDirty).toBe(true);
    expect(harness.sessionsDirty).toBe(true);
    expect(Array.from(harness.sessionsDirtyFiles)).toEqual([dirtySessionFile]);
  });

  it("marks clean full reindex work dirty after a shadow full reindex fails late", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
      }),
    );
    const harness = memoryManager as unknown as ReindexHarness;
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };

    harness.syncMemoryFiles = async () => emptySyncPlan;
    harness.syncArchiveFiles = async () => emptySyncPlan;
    harness.writeMeta = () => {
      throw new Error("late clean reindex failure");
    };

    await expect(memoryManager.sync({ reason: "test", force: true })).rejects.toThrow(
      "late clean reindex failure",
    );

    expect(harness.dirty).toBe(true);
    expect(harness.sessionsDirty).toBe(true);
    expect(harness.sessionsFullRetryDirty).toBe(true);
    expect(harness.sessionsDirtyFiles.size).toBe(0);
  });

  it("keeps the published memory index when a shadow full reindex fails late", async () => {
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha", "utf8");
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["memory"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const publishedRows = harness.db
      .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
      .all();
    expect(publishedRows.length).toBeGreaterThan(0);

    await fs.writeFile(path.join(memoryDir, "alpha.md"), "replacement beta", "utf8");
    harness.writeMeta = () => {
      throw new Error("late shadow failure");
    };

    await expect(memoryManager.sync({ reason: "test", force: true })).rejects.toThrow(
      "late shadow failure",
    );
    expect(
      harness.db
        .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
        .all(),
    ).toEqual(publishedRows);
  });

  it("bounds the shadow cache before any entries reach the primary", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    const harness = memoryManager as unknown as ReindexHarness;
    harness.cache.maxEntries = 2;
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(memoryDir, `${i}.md`), `unique cache content ${i}`);
    }
    // Reject transient overflow too: checking only the final row count misses
    // primary-file high-water growth followed by post-publication deletion.
    harness.db.exec(`
      CREATE TEMP TRIGGER reject_cache_overflow BEFORE INSERT ON memory_embedding_cache
      WHEN (SELECT COUNT(*) FROM memory_embedding_cache) >= 2
      BEGIN SELECT RAISE(ABORT, 'primary cache overflow'); END;
    `);

    await memoryManager.sync({ reason: "cli", force: true });

    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({ count: 2 });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()).toEqual({
      count: 4,
    });
  });

  it("leaves even an oversized published cache untouched when a full rebuild fails", async () => {
    const { memoryManager, harness, before } = await createOversizedPublishedCache();
    harness.writeMeta = () => {
      throw new Error("failed shadow metadata");
    };

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "failed shadow metadata",
    );

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      before,
    );
  });

  async function createOversizedPublishedCache() {
    const memoryManager = await openManager(
      createCfg({ sources: ["memory", "sessions"], cacheEnabled: true }),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const insert = harness.db.prepare(`
      INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('previous-provider', 'previous-model', 'previous-key', ?, '[0,1,0]', 3, 1)
    `);
    insert.run("old-a");
    insert.run("old-b");
    harness.cache.maxEntries = 1;
    const before = harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all();
    expect(before).toHaveLength(3);
    const newest = harness.db
      .prepare("SELECT * FROM memory_embedding_cache ORDER BY updated_at DESC LIMIT 1")
      .all();
    return { memoryManager, harness, before, newest };
  }

  it.each([
    { force: false, outcome: "bounds the published cache" },
    { force: true, outcome: "preserves the published cache" },
  ])("$outcome on unavailable-provider preflight (force=$force)", async ({ force }) => {
    const { memoryManager, harness, before, newest } = await createOversizedPublishedCache();
    // Model runtime provider loss after successful initialization; keep the
    // real sync admission, provider preflight, and SQLite cache cleanup intact.
    harness.provider = null;

    await expect(memoryManager.sync({ reason: "cli", force })).rejects.toThrow(
      /Memory sync unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      force ? before : newest,
    );
  });

  it.each([false, true])("bounds unresolved targeted sync cache when force=%s", async (force) => {
    const { memoryManager, harness, newest } = await createOversizedPublishedCache();
    const publishedChunks = harness.db
      .prepare("SELECT * FROM memory_index_chunks ORDER BY id")
      .all();

    await memoryManager.sync({
      reason: "queued-sessions",
      force,
      sessions: [
        { agentId: "main", sessionId: "missing-session", sessionKey: "agent:main:missing-session" },
      ],
    });

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      newest,
    );
    expect(harness.db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(
      publishedChunks,
    );
  });

  it("still bounds committed incremental work when its progress callback fails", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    harness.cache.maxEntries = 1;
    harness.dirty = true;
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "incremental beta");

    await expect(
      memoryManager.sync({
        reason: "session-delta",
        progress: ({ completed }) => {
          if (completed > 0) {
            throw new Error("failed progress callback");
          }
        },
      }),
    ).rejects.toThrow("failed progress callback");

    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({ count: 1 });
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").get()).toEqual({
      text: "incremental beta",
    });
  });

  it("rejects a full reindex while another process owns the build lock", async () => {
    const memoryManager = await openManager(createCfg({ provider: "none", sources: ["memory"] }));
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const lock = await waitForMemoryReindexLock(databasePath);

    try {
      await expect(memoryManager.sync({ reason: "test", force: true })).rejects.toThrow(
        /another reindex is active/,
      );
    } finally {
      lock.release();
    }
  });

  it("refuses reset during incremental embeddings, then clears and rebuilds their writes", async () => {
    const memoryPath = path.join(memoryDir, "alpha.md");
    await fs.writeFile(memoryPath, "published alpha");
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const provider = harness.provider;
    if (!provider) {
      throw new Error("expected the test embedding provider");
    }
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const reset = () =>
      resetMemoryDatabase({ targetDb: harness.db, dbPath: databasePath, workspaceDir });
    let releaseEmbedding = () => {};
    let markEmbeddingStarted = () => {};
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    vi.spyOn(provider, "embedBatch").mockImplementationOnce(async (inputs) => {
      markEmbeddingStarted();
      await embeddingGate;
      return inputs.map(() => [0, 1, 0]);
    });
    await fs.writeFile(memoryPath, "incremental beta");
    harness.dirty = true;
    const activeSync = memoryManager.sync({ reason: "session-delta" });
    try {
      await embeddingStarted;
      await expect(reset()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "published alpha" },
      ]);
    } finally {
      releaseEmbedding();
      await activeSync;
    }

    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "incremental beta" },
    ]);
    await expect(reset()).resolves.toBe(true);
    for (const table of ["memory_index_sources", "memory_index_chunks", "memory_embedding_cache"]) {
      expect(harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    await memoryManager.sync({ reason: "cli" });
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "incremental beta" },
    ]);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({
      count: 1,
    });
  });

  it("waits for the build lock without blocking the event loop", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const lock = await waitForMemoryReindexLock(databasePath);
    let timerFired = false;
    let lockReleased = false;

    try {
      const wait = waitForMemoryReindexLock(databasePath);
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 10);
      });

      await timer;
      expect(timerFired).toBe(true);
      lock.release();
      lockReleased = true;
      const waitedLock = await wait;
      waitedLock.release();
    } finally {
      if (!lockReleased) {
        lock.release();
      }
    }
  });

  it("forces source-wide session sync when retrying a failed full reindex", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };
    const sessionSyncCalls: SyncArchiveParams[] = [];

    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.sessionsDirtyFiles.clear();
    harness.syncArchiveFiles = async (params) => {
      sessionSyncCalls.push(params);
      return emptySyncPlan;
    };

    await harness.sync({ reason: "test" });

    expect(sessionSyncCalls).toHaveLength(1);
    expect(sessionSyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(sessionSyncCalls[0]?.targetArchiveFiles).toBeUndefined();
    expect(harness.sessionsDirty).toBe(false);
    expect(harness.sessionsFullRetryDirty).toBe(false);
  });

  it("requires doctor for legacy schemas before exposing a manager", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE memory_index_chunks (id TEXT PRIMARY KEY)");
    db.close();

    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({
      cfg: createCfg({ provider: "none", sources: ["memory"] }),
      agentId: "main",
    });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("uses schema version 0; run openclaw doctor --fix");
    const reopened = new DatabaseSync(databasePath);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    reopened.close();
  });

  it("full-reindexes sessions-only retry state when metadata is mismatched", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const reindexCalls: Array<{ reason?: string; force?: boolean }> = [];

    harness.db
      .prepare(
        `INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "sessions-retry-chunk",
        "sessions/retry.jsonl",
        "sessions",
        1,
        1,
        "sessions-retry-hash",
        "fts-only",
        "sessions retry marker",
        "[]",
        Date.now(),
      );
    harness.writeMeta({
      model: "fts-only",
      provider: "none",
      providerKey: harness.providerKey ?? undefined,
      sources: ["memory"],
      chunkTokens: 4000,
      chunkOverlap: 0,
    });
    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.runInPlaceReindex = async (params) => {
      reindexCalls.push(params);
    };

    await harness.sync({ reason: "test" });

    expect(reindexCalls).toHaveLength(1);
    expect(reindexCalls[0]).toMatchObject({ reason: "test" });
  });

  it("forces source-wide memory sync when retrying a failed full reindex", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["memory"],
      }),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "alpha", "utf8");
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const memorySync = vi.spyOn(harness, "syncMemoryFiles");

    harness.dirty = true;
    harness.memoryFullRetryDirty = true;

    await harness.sync({ reason: "test" });

    expect(memorySync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ needsFullReindex: true }),
    );
    expect(harness.dirty).toBe(false);
    expect(harness.memoryFullRetryDirty).toBe(false);
  });
});
