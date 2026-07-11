// Memory Core tests cover manager reindex recovery plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

type SessionDeltaState = { lastSize: number; pendingBytes: number; pendingMessages: number };
type SyncArchiveParams = { needsFullReindex: boolean; targetArchiveFiles?: string[] };

type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runInPlaceReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
  syncArchiveFiles: (params: SyncArchiveParams) => Promise<unknown>;
  db: DatabaseSync;
  writeMeta: (meta: MemoryIndexMeta) => void;
  providerKey: string | null;
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
  sessionDeltas: Map<string, SessionDeltaState>;
};

describe("memory manager reindex recovery", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
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
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createCfg(params: {
    provider?: string;
    sources?: Array<"memory" | "sessions">;
  }): OpenClawConfig {
    return {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            remote: { nonBatchConcurrency: 1 },
            cache: { enabled: false },
            sources: params.sources,
            experimental: { sessionMemory: params.sources?.includes("sessions") ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
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
    const originalDelta: SessionDeltaState = {
      lastSize: 42,
      pendingBytes: 100,
      pendingMessages: 2,
    };
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };

    harness.dirty = true;
    harness.sessionsDirty = true;
    harness.sessionsDirtyFiles.add(dirtySessionFile);
    harness.sessionDeltas.set(dirtySessionFile, { ...originalDelta });
    harness.syncMemoryFiles = async () => emptySyncPlan;
    harness.syncArchiveFiles = async () => {
      const delta = harness.sessionDeltas.get(dirtySessionFile);
      if (delta) {
        delta.lastSize = 500;
        delta.pendingBytes = 0;
        delta.pendingMessages = 0;
      }
      return emptySyncPlan;
    };
    harness.writeMeta = () => {
      throw new Error("late reindex failure");
    };

    await expect(harness.runInPlaceReindex({ reason: "test", force: true })).rejects.toThrow(
      "late reindex failure",
    );

    expect(harness.dirty).toBe(true);
    expect(harness.memoryFullRetryDirty).toBe(true);
    expect(harness.sessionsDirty).toBe(true);
    expect(Array.from(harness.sessionsDirtyFiles)).toEqual([dirtySessionFile]);
    expect(harness.sessionDeltas.get(dirtySessionFile)).toEqual(originalDelta);
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

    await expect(harness.runInPlaceReindex({ reason: "test", force: true })).rejects.toThrow(
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

    await expect(harness.runInPlaceReindex({ reason: "test", force: true })).rejects.toThrow(
      "late shadow failure",
    );
    expect(
      harness.db
        .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
        .all(),
    ).toEqual(publishedRows);
  });

  it("rejects a full reindex while another process owns the build lock", async () => {
    const memoryManager = await openManager(createCfg({ provider: "none", sources: ["memory"] }));
    const harness = memoryManager as unknown as ReindexHarness;
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const lock = acquireMemoryReindexLock(databasePath);

    try {
      await expect(harness.runInPlaceReindex({ reason: "test", force: true })).rejects.toThrow(
        /another reindex is active/,
      );
    } finally {
      lock.release();
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

  it("closes the database after constructor schema failure", async () => {
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
    expect(result.error).toMatch(/no such column: path/);
    const reopened = new DatabaseSync(databasePath);
    expect(reopened.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
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
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };
    const memorySyncCalls: Array<{ needsFullReindex: boolean }> = [];

    harness.dirty = true;
    harness.memoryFullRetryDirty = true;
    harness.syncMemoryFiles = async (params: { needsFullReindex: boolean }) => {
      memorySyncCalls.push(params);
      return emptySyncPlan;
    };

    await harness.sync({ reason: "test" });

    expect(memorySyncCalls).toHaveLength(1);
    expect(memorySyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(harness.dirty).toBe(false);
    expect(harness.memoryFullRetryDirty).toBe(false);
  });
});
