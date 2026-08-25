// Memory Core tests cover manager search orchestration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  type ManagerIndexFixtureConfig,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

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

  it("retries transient query embedding transport failures during search", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let queryCalls = 0;
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embedQuery: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
        waitForEmbeddingRetry: (delayMs: number, action: string) => Promise<void>;
      }
    ).provider = {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => {
        queryCalls += 1;
        if (queryCalls === 1) {
          throw new Error("TypeError: fetch failed | other side closed");
        }
        return [1, 0, 0, 0];
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
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
        provider: {
          id: string;
          model: string;
          embedQuery: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => {
        queryCalls += 1;
        throw new Error("TypeError: fetch failed | other side closed");
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
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
      provider: {
        id: string;
        model: string;
        embedQuery: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      };
      providerKey: string;
      providerLifecycle: { mode: "active"; providerId: string };
      computeProviderKey: () => string;
    };
    fields.provider = {
      id: "local",
      model: "mock-embed",
      embedQuery: async () => {
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
    const provider = Reflect.get(manager, "provider") as {
      embedQuery: (text: string) => Promise<number[]>;
    };
    const embedQuerySpy = vi.spyOn(provider, "embedQuery");

    for (const entry of cases) {
      const results = await manager.search(entry.query, { maxResults: 6 });
      expect(results.some((result) => result.path.endsWith(`memory/${entry.recallFile}`))).toBe(
        true,
      );
    }
    expect(embedQuerySpy).toHaveBeenCalledTimes(cases.length);
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
      "Unrelated path-only candidate.",
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
    const syncAdmitted = vi
      .spyOn(
        manager as unknown as {
          syncAdmitted: (params: { reason: string }) => Promise<void>;
        },
        "syncAdmitted",
      )
      .mockImplementation(async () => await pendingSync);

    Reflect.set(manager, "dirty", false);
    Reflect.set(manager, "sessionsDirty", true);

    const searchPromise = manager.search("zebra", {
      maxResults: 5,
      minScore: 0,
    });
    await vi.waitFor(() => expect(syncAdmitted).toHaveBeenCalledWith({ reason: "search" }));

    const results = await searchPromise;
    expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
    releaseSync();
    await pendingSync;
  });

  it("reports session-only refreshes from the manager sync owner", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });

    Reflect.set(manager, "dirty", false);
    Reflect.set(manager, "sessionsDirty", true);
    Reflect.set(manager, "syncing", new Promise<void>(() => {}));
    try {
      expect(manager.status().pendingSyncSources).toEqual(["sessions"]);
    } finally {
      Reflect.set(manager, "syncing", null);
      Reflect.set(manager, "sessionsDirty", false);
    }
  });

  it("waits for dirty sync before querying", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    await fs.writeFile(
      path.join(fixture.paths.memory, "search-sync.md"),
      "Current memory appears only after the dirty search sync.",
    );
    await vi.waitFor(() => expect(manager.status().dirty).toBe(true));

    const results = await manager.search("current dirty search sync", {
      maxResults: 5,
      minScore: 0,
    });

    expect(results.some((entry) => entry.path === "memory/search-sync.md")).toBe(true);
  });
});
