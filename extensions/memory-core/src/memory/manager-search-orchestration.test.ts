// Memory Core tests cover manager search orchestration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { recordMemoryEntryOrigins } from "../memory-entry-origins.js";
import { forgetMemoryEntries } from "../memory-forget.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { MemoryIndexRevisionConflictError } from "./manager-db.js";
import {
  createManagerIndexFixture,
  type ManagerIndexFixtureConfig,
} from "./manager-index.test-support.js";
import * as knnSubprocess from "./manager-search-knn-subprocess.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFreshManager,
    getFtsSessionManager,
    getPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
    trackManager,
  } = fixture;

  async function expectHybridKeywordSearchFindsMemory(
    cfg: Parameters<typeof getMemorySearchManager>[0]["cfg"],
  ) {
    const manager = await getFreshManager(cfg);
    try {
      const status = manager.status();
      if (!status.fts?.available) {
        return;
      }

      await manager.sync({ reason: "test" });
      const results = await manager.search("zebra");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
    } finally {
      await manager.close?.();
    }
  }

  it.each([
    {
      name: "zero vector weight",
      config: {
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      } satisfies ManagerIndexFixtureConfig,
    },
    {
      name: "minimum score exceeds text weight",
      config: {
        minScore: 0.35,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      } satisfies ManagerIndexFixtureConfig,
    },
  ])("finds keyword matches via hybrid search when $name", async ({ config }) => {
    await expectHybridKeywordSearchFindsMemory(createCfg(config));
  });

  it("keeps one search generation while a concurrent reindex waits to publish", async () => {
    const manager = await getPersistentManager(
      createCfg({
        vectorEnabled: true,
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 1, textWeight: 0 },
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      db: DatabaseSync;
      provider: EmbeddingProvider;
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
    };
    const queryStarted = createDeferred<void>();
    const releaseQuery = createDeferred<void>();
    const shadowReady = createDeferred<void>();
    const releaseReindex = createDeferred<void>();
    const childReady = createDeferred<void>();
    const releaseChild = createDeferred<void>();
    const publishedDb = fields.db;
    const publishedChunks = manager.status().chunks;
    let shadowDb: DatabaseSync | undefined;
    const syncMemoryFiles = fields.syncMemoryFiles.bind(manager);
    const runKnn = knnSubprocess.runVectorKnnInSubprocess;
    const querySpy = vi.spyOn(fields.provider, "embed").mockImplementation(async () => {
      queryStarted.resolve();
      await releaseQuery.promise;
      return [1, 0, 0, 0];
    });
    const syncSpy = vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (params) => {
      shadowDb = fields.db;
      expect(manager.status().chunks).toBe(publishedChunks);
      const lexical = await manager.search("zebra", { lexicalOnly: true, minScore: 0 });
      expect(lexical.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      const result = await syncMemoryFiles(params);
      shadowReady.resolve();
      await releaseReindex.promise;
      return result;
    });
    const childSpy = vi
      .spyOn(knnSubprocess, "runVectorKnnInSubprocess")
      .mockImplementation(async (params) => {
        const result = await runKnn(params);
        expect(result.rows.length).toBeGreaterThan(0);
        childReady.resolve();
        await releaseChild.promise;
        return result;
      });
    let search: ReturnType<typeof manager.search> | undefined;
    let reindex: ReturnType<typeof manager.sync> | undefined;
    try {
      search = manager.search("semantic needle without lexical overlap");
      await queryStarted.promise;
      reindex = manager.sync({ reason: "test", force: true });
      await shadowReady.promise;
      expect(fields.db).toBe(publishedDb);
      releaseQuery.resolve();
      await childReady.promise;
      releaseReindex.resolve();
      let reindexSettled = false;
      void reindex.then(() => {
        reindexSettled = true;
      });
      await Promise.resolve();
      expect(reindexSettled).toBe(false);

      releaseChild.resolve();
      const results = await search;
      expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await reindex;
      expect(shadowDb?.isOpen).toBe(false);
    } finally {
      releaseQuery.resolve();
      releaseReindex.resolve();
      releaseChild.resolve();
      await Promise.allSettled([search, reindex]);
      childSpy.mockRestore();
      syncSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  it("retries transient query embedding transport failures during search", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let queryCalls = 0;
    (
      manager as unknown as {
        provider: EmbeddingProvider;
        waitForEmbeddingRetry: (delayMs: number, action: string) => Promise<void>;
      }
    ).provider = {
      id: "mock",
      model: "mock-embed",
      embed: async () => {
        queryCalls += 1;
        if (queryCalls === 1) {
          throw new Error("TypeError: fetch failed | other side closed");
        }
        return [1, 0, 0, 0];
      },
      embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };
    (
      manager as unknown as {
        waitForEmbeddingRetry: (delayMs: number, action: string) => Promise<void>;
      }
    ).waitForEmbeddingRetry = async () => {};

    const results = await manager.search("alpha");

    expect(queryCalls).toBe(2);
    expect(results.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(true);
  });

  it("fails search after bounded query embedding retries are exhausted", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let queryCalls = 0;
    (
      manager as unknown as {
        provider: EmbeddingProvider;
      }
    ).provider = {
      id: "mock",
      model: "mock-embed",
      embed: async () => {
        queryCalls += 1;
        throw new Error("TypeError: fetch failed | other side closed");
      },
      embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };
    (
      manager as unknown as {
        waitForEmbeddingRetry: (delayMs: number, action: string) => Promise<void>;
      }
    ).waitForEmbeddingRetry = async () => {};

    await expect(manager.search("alpha")).rejects.toThrow("fetch failed");
    expect(queryCalls).toBe(3);
  });

  it("keeps a healthy local provider active when the caller cancels search", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const close = vi.fn(async () => {});
    let queryCalls = 0;
    const fields = manager as unknown as {
      provider: EmbeddingProvider;
      providerKey: string;
      providerLifecycle: { mode: "active"; providerId: string };
      computeProviderKey: () => string;
    };
    fields.provider = {
      id: "local",
      model: "mock-embed",
      embed: async () => {
        queryCalls += 1;
        return [1, 0, 0, 0];
      },
      embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
      close,
    };
    fields.providerLifecycle = { mode: "active", providerId: "local" };
    fields.providerKey = fields.computeProviderKey();
    await manager.sync({ reason: "test", force: true });

    const abortReason = new Error("memory search was cancelled");
    await expect(
      manager.search("alpha", { signal: AbortSignal.abort(abortReason) }),
    ).rejects.toMatchObject({ cause: abortReason });

    expect(manager.status()).toMatchObject({
      provider: "local",
      custom: {
        providerState: { mode: "active", providerId: "local" },
        providerUnavailableReason: undefined,
      },
    });
    await expect(manager.search("alpha")).resolves.not.toStrictEqual([]);
    expect(queryCalls).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects caller cancellation during hybrid fallback scanning", async () => {
    const manager = await getPersistentManager(
      createCfg({
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
      }),
    );
    await manager.sync({ reason: "test" });

    const fields = manager as unknown as {
      db: DatabaseSync;
      ensureVectorReady: (dimensions?: number) => Promise<boolean>;
    };
    fields.ensureVectorReady = async () => false;
    const insertChunk = fields.db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < 4096; index += 1) {
      insertChunk.run(
        `cancel-scan-${index}`,
        `memory/cancel-scan-${index}.md`,
        "memory",
        1,
        1,
        `cancel-scan-hash-${index}`,
        "mock-embed",
        `fallback scan row ${index}`,
        JSON.stringify([0, 1, 0, 0]),
        index,
      );
    }

    const originalPrepare = fields.db.prepare.bind(fields.db);
    let scannedBatches = 0;
    const prepareSpy = vi.spyOn(fields.db, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SELECT rowid, id, path")) {
        return statement;
      }
      return {
        all: (...args: Parameters<typeof statement.all>) => {
          scannedBatches += 1;
          return statement.all(...args);
        },
      } as unknown as typeof statement;
    });

    try {
      const caller = new AbortController();
      const abortReason = new Error("caller stopped hybrid memory search");
      const pending = manager.search("alpha", { signal: caller.signal });
      setImmediate(() => caller.abort(abortReason));

      await expect(pending).rejects.toBe(abortReason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(scannedBatches).toBe(1);

      const healthyResults = await manager.search("alpha");
      expect(healthyResults.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);

      fields.ensureVectorReady = async () => {
        throw new Error("vector store unavailable");
      };
      const degradedResults = await manager.search("alpha");
      expect(degradedResults.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("supplements thin strict FTS results for conversational queries", async () => {
    const cases = [
      {
        query: "that thing we discussed about the API",
        strictFile: "strict-english.md",
        strictText: "That thing we discussed about the API belongs in the first draft.",
        recallFile: "recall-english.md",
        recallText: "API authentication uses short-lived OAuth tokens.",
      },
      {
        query: "ayer hablamos sobre estrategia de despliegue",
        strictFile: "strict-spanish.md",
        strictText: "Ayer hablamos sobre estrategia de despliegue para la primera region.",
        recallFile: "recall-spanish.md",
        recallText: "La estrategia de despliegue requiere una ventana de mantenimiento.",
      },
    ] as const;
    for (const entry of cases) {
      await fs.writeFile(path.join(fixture.paths.memory, entry.strictFile), entry.strictText);
      await fs.writeFile(path.join(fixture.paths.memory, entry.recallFile), entry.recallText);
    }

    const manager = await getPersistentManager(
      createCfg({
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      }),
    );
    await manager.sync({ reason: "test" });
    const provider = Reflect.get(manager, "provider") as EmbeddingProvider;
    const embedSpy = vi.spyOn(provider, "embed");

    for (const entry of cases) {
      const results = await manager.search(entry.query, { maxResults: 6 });
      expect(results.some((result) => result.path.endsWith(`memory/${entry.recallFile}`))).toBe(
        true,
      );
    }
    expect(embedSpy).toHaveBeenCalledTimes(cases.length);
  });

  it("bounds per-keyword FTS fallback in provider-backed hybrid search", async () => {
    const cfg = createCfg({
      minScore: 0.35,
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => unknown;
        };
      }
    ).db;
    const originalPrepare = db.prepare.bind(db);
    let ftsSelects = 0;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (
        sql.includes("FROM memory_index_chunks_fts") &&
        sql.includes("WHERE memory_index_chunks_fts MATCH ?")
      ) {
        ftsSelects += 1;
      }
      return originalPrepare(sql);
    });

    try {
      const results = await manager.search(
        "zebra project router gateway session transcript approval command owner workspace token budget retry queue",
        { maxResults: 5 },
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      expect(ftsSelects).toBeGreaterThan(1);
      expect(ftsSelects).toBeLessThanOrEqual(7);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("preserves fallback body boosts through hybrid weighting", async () => {
    const manager = await getPersistentManager(
      createCfg({
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      }),
    );
    await fs.writeFile(
      path.join(fixture.paths.memory, "body.md"),
      "Alpha gamma alpha gamma strongest fallback body match.",
    );
    await fs.writeFile(
      path.join(fixture.paths.memory, "alpha.md"),
      "Unrelated beta path-only candidate.",
    );
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha gamma", { maxResults: 2, minScore: 0 });

    expect(results.map((entry) => entry.path)).toEqual(["memory/body.md", "memory/alpha.md"]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("bootstraps an empty index on first search so session transcript hits are available", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-bootstrap",
      });
      if (!manager) {
        return;
      }

      await seedMemoryIndexSessionTranscript({
        sessionId: "session-bootstrap",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-07T15:25:04.113Z",
            content: "The current Project Nebula codename is ORBIT-10.",
          },
        ],
      });

      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      fixture.restoreStateDir();
    }
  });

  it("keeps remember-only session transcripts out of ordinary manager searches", async () => {
    providerFixture.forceNoProvider = true;
    fixture.setStateDir(path.join(fixture.paths.workspace, ".state-remember-search-sources"));
    try {
      const cfg = createCfg({
        provider: "none",
        rememberAcrossConversations: true,
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      });
      const manager = await getFreshManager(cfg);
      trackManager(manager);
      if (!manager.status().fts?.available) {
        return;
      }

      await seedMemoryIndexSessionTranscript({
        sessionId: "remember-only",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-07T15:25:04.113Z",
            content: "Recall-only canary is NEBULA-47.",
          },
        ],
      });

      await manager.sync({ reason: "test", force: true });

      await expect(
        manager.search("Recall-only canary NEBULA-47", { minScore: 0 }),
      ).resolves.toEqual([]);
      const trustedResults = await manager.search("Recall-only canary NEBULA-47", {
        minScore: 0,
        sources: ["sessions"],
      });
      expect(trustedResults[0]?.source).toBe("sessions");
    } finally {
      fixture.restoreStateDir();
    }
  });

  it("returns before provider or index bootstrap for a blank query", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "required-provider", hybrid: { enabled: true } }),
    );
    providerFixture.providerCalls = [];

    await expect(manager.search(" \n\t ")).resolves.toStrictEqual([]);

    expect(providerFixture.providerCalls).toHaveLength(0);
  });

  it("does not block querying on session reconciliation", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });

    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const backgroundSync = vi
      .spyOn(
        manager as unknown as {
          syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
        },
        "syncPublishedIndexInBackground",
      )
      .mockImplementation(async () => await pendingSync);

    Reflect.set(manager, "dirty", false);
    Reflect.set(manager, "sessionsDirty", true);

    const searchPromise = manager.search("zebra", {
      maxResults: 5,
      minScore: 0,
    });
    await vi.waitFor(() => expect(backgroundSync).toHaveBeenCalledWith({ reason: "search" }));

    const results = await searchPromise;
    expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
    releaseSync();
    await pendingSync;
  });

  it.each([
    { name: "dirty memory", source: "memory", fullRetry: false },
    { name: "one dirty session", source: "sessions", fullRetry: false },
    { name: "full memory retry", source: "memory", fullRetry: true },
  ] as const)(
    "keeps search usable while maintenance syncs $name",
    async ({ source, fullRetry }) => {
      providerFixture.forceNoProvider = true;
      const cfg = createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        minScore: 0,
        onSearch: true,
        hybrid: { enabled: true },
      });
      const manager = await getPersistentManager(cfg);
      await manager.sync({ reason: "test", force: true });
      // This fixture supplies one exact dirty generation, without later native
      // watcher notifications adding another generation during the handoff.
      (
        manager as unknown as { closeNativeMemoryWatchPairs: () => void }
      ).closeNativeMemoryWatchPairs();
      const content = "Current memory appears only after the dirty search sync.";
      if (source === "memory") {
        await fs.writeFile(path.join(fixture.paths.memory, "search-sync.md"), content);
      } else {
        await seedMemoryIndexSessionTranscript({
          sessionId: "search-sync",
          messages: [{ role: "assistant", timestamp: Date.now(), content }],
        });
      }
      const servingFields = manager as unknown as {
        dirty: boolean;
        memoryFullRetryDirty: boolean;
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        listSessionCorpusEntries: () => Promise<Array<{ sessionFile: string }>>;
        awaitManagerIdle: () => Promise<void>;
      };
      servingFields.dirty = source === "memory";
      servingFields.memoryFullRetryDirty = fullRetry;
      servingFields.sessionsDirty = source === "sessions";
      if (source === "sessions") {
        const entries = await servingFields.listSessionCorpusEntries();
        expect(entries).toHaveLength(1);
        servingFields.sessionsDirtyFiles = new Set(entries.map((entry) => entry.sessionFile));
      }

      const maintenanceReady = createDeferred<void>();
      const releaseMaintenance = createDeferred<void>();
      const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
      let maintenanceClosed = false;
      let maintenanceFields:
        | {
            runInPlaceReindex: (params: unknown) => Promise<void>;
            syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
            syncArchiveFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
          }
        | undefined;
      const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
        const acquired = await originalGet(params);
        if (params.purpose !== "maintenance" || !acquired) {
          return acquired;
        }
        const closeMaintenance = acquired.close.bind(acquired);
        vi.spyOn(acquired, "close").mockImplementation(async () => {
          await closeMaintenance();
          maintenanceClosed = true;
        });
        const fields = acquired as unknown as NonNullable<typeof maintenanceFields>;
        maintenanceFields = fields;
        vi.spyOn(fields, "runInPlaceReindex");
        const sourceSync = source === "memory" ? "syncMemoryFiles" : "syncArchiveFiles";
        const syncSource = fields[sourceSync].bind(acquired);
        vi.spyOn(fields, sourceSync).mockImplementation(async (syncParams) => {
          // Full retries hold completed shadow writes; incremental sync holds before
          // its live writes so both cases prove reads remain available during work.
          const result = fullRetry ? await syncSource(syncParams) : undefined;
          maintenanceReady.resolve();
          await releaseMaintenance.promise;
          return fullRetry ? result : await syncSource(syncParams);
        });
        return acquired;
      });

      try {
        const firstSearch = manager.search("zebra", { maxResults: 5, minScore: 0 });
        await maintenanceReady.promise;
        expect(manager.status()).toMatchObject({ dirty: true });
        expect(maintenanceFields!.runInPlaceReindex).toHaveBeenCalledTimes(fullRetry ? 1 : 0);
        expect(
          maintenanceFields![source === "memory" ? "syncMemoryFiles" : "syncArchiveFiles"],
        ).toHaveBeenCalledWith(expect.objectContaining({ needsFullReindex: fullRetry }));

        const publishedResults = await firstSearch;
        expect(publishedResults.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
        await expect(
          manager.search("current dirty search sync", { maxResults: 5, minScore: 0 }),
        ).resolves.toEqual([]);

        releaseMaintenance.resolve();
        await servingFields.awaitManagerIdle();
        expect(manager.status().dirty).toBe(false);

        const refreshedResults = await manager.search("current dirty search sync", {
          maxResults: 5,
          minScore: 0,
        });
        expect(refreshedResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source, snippet: expect.stringContaining(content) }),
          ]),
        );
        expect(maintenanceClosed).toBe(true);
      } finally {
        releaseMaintenance.resolve();
        await servingFields.awaitManagerIdle();
        getSpy.mockRestore();
      }
    },
  );

  it("rebuilds automatic maintenance from the revision after a concurrent memory purge", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      sources: ["memory"],
      minScore: 0,
      onSearch: true,
      hybrid: { enabled: true },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const servingFields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      closeNativeMemoryWatchPairs: () => void;
      awaitManagerIdle: () => Promise<void>;
    };
    servingFields.closeNativeMemoryWatchPairs();

    const sessionId = "automatic-maintenance-purge";
    const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
    await fs.writeFile(
      memoryPath,
      "# Memory\n<!-- openclaw-memory-promotion:private-entry -->\n- Private violet alpha fragment.\n",
    );
    recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          agentId: "main",
          sessionId,
          sessionKey: null,
          entryKey: "private-entry",
          originClass: "owner",
          observedAt: Date.now(),
        },
      ],
    });
    servingFields.dirty = true;
    servingFields.memoryFullRetryDirty = true;

    const shadowReady = createDeferred<void>();
    const releasePublish = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    let syncCalls = 0;
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        syncMemoryFiles: (params: unknown) => Promise<unknown>;
      };
      const syncMemoryFiles = fields.syncMemoryFiles.bind(acquired);
      vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (syncParams) => {
        const result = await syncMemoryFiles(syncParams);
        syncCalls += 1;
        if (syncCalls === 1) {
          shadowReady.resolve();
          await releasePublish.promise;
        }
        return result;
      });
      return acquired;
    });

    try {
      const search = manager.search("zebra", { maxResults: 5, minScore: 0 });
      await shadowReady.promise;
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
      releasePublish.resolve();

      await expect(search).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      await servingFields.awaitManagerIdle();
      expect(manager.status()).toMatchObject({ dirty: false, lastSyncError: undefined });
      expect(syncCalls).toBe(2);
      expect(await fs.readFile(memoryPath, "utf8")).not.toContain("Private violet");
      const database = Reflect.get(manager, "db") as DatabaseSync;
      expect(
        database
          .prepare("SELECT text FROM memory_index_chunks WHERE text LIKE '%Private violet%'")
          .all(),
      ).toEqual([]);
    } finally {
      releasePublish.resolve();
      await servingFields.awaitManagerIdle();
      getSpy.mockRestore();
    }
  });

  it("keeps transient CLI search off the serving manager write path", async () => {
    providerFixture.forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      onSearch: false,
      hybrid: { enabled: true },
    });
    const initialManager = await getFreshManager(cfg, "cli");
    await initialManager.sync({ reason: "test", force: true });
    await initialManager.close?.();
    await fs.writeFile(
      path.join(fixture.paths.memory, "cli-refresh.md"),
      "Content published after transient CLI maintenance.",
    );

    const manager = await getFreshManager(cfg, "cli", true);
    const servingFields = manager as unknown as {
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
    };
    const servingSync = vi.spyOn(servingFields, "syncMemoryFiles");
    const maintenanceReady = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    let closePromise: Promise<void> | undefined;
    let maintenanceClosed = false;
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const closeMaintenance = acquired.close.bind(acquired);
      vi.spyOn(acquired, "close").mockImplementation(async () => {
        await closeMaintenance();
        maintenanceClosed = true;
      });
      const fields = acquired as unknown as {
        syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
      };
      const syncMemoryFiles = fields.syncMemoryFiles.bind(acquired);
      vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (syncParams) => {
        const result = await syncMemoryFiles(syncParams);
        maintenanceReady.resolve();
        await releaseMaintenance.promise;
        return result;
      });
      return acquired;
    });

    try {
      const search = manager.search("zebra", {
        maxResults: 5,
        minScore: 0,
        sessionKey: "agent:main:cli:memory-search",
      });
      await vi.waitFor(() =>
        expect(getSpy).toHaveBeenCalledWith(expect.objectContaining({ purpose: "maintenance" })),
      );
      await maintenanceReady.promise;
      const results = await search;

      expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      expect(servingSync).not.toHaveBeenCalled();
      if (typeof manager.close !== "function") {
        throw new Error("Expected CLI memory manager close support");
      }
      closePromise = manager.close();
      let closeSettled = false;
      void closePromise.then(() => {
        closeSettled = true;
      });
      await vi.waitFor(() => expect(closeSettled).toBe(true));
      expect(maintenanceClosed).toBe(false);
    } finally {
      releaseMaintenance.resolve();
      await closePromise;
      getSpy.mockRestore();
      await manager.close?.();
    }
  });

  it.each([
    {
      name: "an unrelated error",
      error: new Error("maintenance failed"),
      expectedSyncCalls: 1,
    },
    {
      name: "a second revision conflict",
      error: new MemoryIndexRevisionConflictError("stale shadow"),
      expectedSyncCalls: 2,
    },
  ])(
    "restores a failed maintenance generation after $name and still closes its transient manager",
    async ({ error: syncError, expectedSyncCalls }) => {
      const manager = await getPersistentManager(
        createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
      );
      await manager.sync({ reason: "test" });
      const maintenance = {
        adoptReindexRetryState: vi.fn(),
        sync: vi.fn(async () => {
          throw syncError;
        }),
        close: vi.fn(async () => {}),
      };
      const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
      Reflect.set(manager, "dirty", true);
      Reflect.set(manager, "memoryFullRetryDirty", true);
      Reflect.set(manager, "sessionsDirty", true);
      Reflect.set(manager, "sessionsFullRetryDirty", true);
      Reflect.set(manager, "sessionsReconcileDirty", true);
      Reflect.set(manager, "sessionsDirtyFiles", new Set(["session.jsonl"]));

      try {
        await expect(
          (
            manager as unknown as {
              syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
            }
          ).syncPublishedIndexInBackground({ reason: "search" }),
        ).rejects.toThrow(syncError);

        expect(maintenance.adoptReindexRetryState).toHaveBeenCalledWith({
          dirty: true,
          memoryFullRetryDirty: true,
          fullReindexRetryBackoff: { attempts: 0, retryAt: 0 },
          sessionsDirty: true,
          sessionsFullRetryDirty: true,
          sessionsReconcileDirty: true,
          sessionsDirtyFiles: new Set(["session.jsonl"]),
        });
        expect(maintenance.sync).toHaveBeenCalledTimes(expectedSyncCalls);
        expect(maintenance.sync).toHaveBeenCalledWith({ reason: "search" });
        expect(maintenance.close).toHaveBeenCalledTimes(1);
        expect(manager.status().lastSyncError).toContain(syncError.message);
        expect(Reflect.get(manager, "dirty")).toBe(true);
        expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
        expect(Reflect.get(manager, "sessionsDirty")).toBe(true);
        expect(Reflect.get(manager, "sessionsFullRetryDirty")).toBe(true);
        expect(Reflect.get(manager, "sessionsReconcileDirty")).toBe(true);
        expect(Reflect.get(manager, "sessionsDirtyFiles")).toEqual(new Set(["session.jsonl"]));
      } finally {
        getSpy.mockRestore();
      }
    },
  );

  it("keeps sync failures process-local and clears them after a successful sync", async () => {
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      onSearch: true,
      hybrid: { enabled: true },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "baseline" });
    const fields = manager as unknown as {
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
    };
    const syncMemoryFiles = fields.syncMemoryFiles.bind(manager);
    const syncSpy = vi
      .spyOn(fields, "syncMemoryFiles")
      .mockRejectedValueOnce(new Error("sync failed"));
    Reflect.set(manager, "dirty", true);

    await expect(manager.sync({ reason: "failure" })).rejects.toThrow("sync failed");
    expect(manager.status().lastSyncError).toBe("sync failed");
    const statusManager = await getFreshManager(cfg, "status");
    expect(statusManager.status().lastSyncError).toBeUndefined();

    syncSpy.mockImplementation(syncMemoryFiles);
    await manager.sync({ reason: "recovery" });
    expect(manager.status().lastSyncError).toBeUndefined();
  });

  it("does not let a no-op sync hide a later detached failure", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "baseline" });
    const maintenanceStarted = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const maintenance = {
      adoptReindexRetryState: vi.fn(),
      sync: vi.fn(async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
        throw new Error("older maintenance failed");
      }),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const detachedSync = (
      manager as unknown as {
        syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
      }
    ).syncPublishedIndexInBackground({ reason: "search" });

    try {
      await maintenanceStarted.promise;
      expect(manager.status().dirty).toBe(false);
      await manager.sync({ reason: "interval" });
      releaseMaintenance.resolve();
      await expect(detachedSync).rejects.toThrow("older maintenance failed");

      expect(manager.status().dirty).toBe(true);
      expect(manager.status().lastSyncError).toContain("older maintenance failed");

      await manager.sync({ reason: "retry" });
      expect(manager.status().lastSyncError).toBeUndefined();
    } finally {
      releaseMaintenance.resolve();
      await detachedSync.catch(() => undefined);
      getSpy.mockRestore();
    }
  });

  it("restores a maintenance generation when a null fallback leaves it dirty", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      minScore: 0,
      onSearch: true,
      hybrid: { enabled: true },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test", force: true });
    await fs.writeFile(
      path.join(fixture.paths.memory, "null-fallback.md"),
      "New content that requires a fallback embedding.",
    );
    Reflect.set(manager, "dirty", true);
    Reflect.set(manager, "memoryFullRetryDirty", true);
    providerFixture.providerNullResult = "fallback-provider";
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        ensureProviderInitialized: () => Promise<void>;
        provider: EmbeddingProvider | null;
      };
      await fields.ensureProviderInitialized();
      if (!fields.provider) {
        throw new Error("expected maintenance embedding provider");
      }
      fields.provider.embedBatch = async () => {
        throw providerFixture.createLocalWorkerExitError();
      };
      return acquired;
    });

    try {
      await expect(
        (
          manager as unknown as {
            syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
          }
        ).syncPublishedIndexInBackground({ reason: "search" }),
      ).resolves.toBeUndefined();

      expect(manager.status().dirty).toBe(true);
      expect(manager.status().lastSyncError).toContain("Local embedding worker exited");
      expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
    } finally {
      providerFixture.providerNullResult = null;
      getSpy.mockRestore();
    }
  });

  it("does not let a rejected maintenance handoff abort manager teardown", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    Reflect.set(manager, "dirty", true);
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
        },
        "syncPublishedIndexInBackground",
      )
      .mockRejectedValue(new Error("maintenance failed"));

    await manager.search("zebra", { maxResults: 5, minScore: 0 });
    await expect(manager.close?.()).resolves.toBeUndefined();
    expect(syncSpy).toHaveBeenCalledWith({ reason: "search" });
  });
});
