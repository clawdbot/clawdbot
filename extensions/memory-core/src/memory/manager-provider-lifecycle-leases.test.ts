// Memory Core tests cover manager provider lifecycle lease behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, getPersistentManager, trackManager } = fixture;

  it("keeps an active FTS-only generation stable while fallback activates", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "openai", fallback: "fallback-provider" }),
      "cli",
    );
    trackManager(manager);
    type IndexEntry = {
      path: string;
      absPath: string;
      mtimeMs: number;
      size: number;
      hash: string;
      content: string;
    };
    const fields = manager as unknown as {
      provider: { id: string } | null;
      providerKey: string;
      computeProviderKey: () => string;
      ensureProviderInitialized: () => Promise<void>;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      beginSyncProviderGeneration: () => void;
      endSyncProviderGeneration: () => void;
      indexFile: (
        entry: IndexEntry,
        options: { source: "memory"; content: string },
      ) => Promise<void>;
      db: {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { model?: string } | undefined;
        };
      };
    };
    await fields.ensureProviderInitialized();
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
    await vi.waitFor(() => {
      expect(fields.provider).toBeNull();
      expect(providerFixture.providerCloseCalls).toBe(1);
    });

    const createEntry = (name: string): IndexEntry => {
      const content = `# Log\n${name} FTS-only generation.`;
      return {
        path: `memory/${name}.md`,
        absPath: path.join(fixture.paths.memory, `${name}.md`),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(content),
        hash: hashText(content),
        content,
      };
    };
    const first = createEntry("fts-first");
    const second = createEntry("fts-second");
    await fs.writeFile(first.absPath, first.content);
    await fs.writeFile(second.absPath, second.content);

    fields.beginSyncProviderGeneration();
    try {
      await fields.indexFile(first, { source: "memory", content: first.content });
      await expect(fields.activateFallbackProvider("local worker exited")).resolves.toBe(true);
      await fields.indexFile(second, { source: "memory", content: second.content });
    } finally {
      fields.endSyncProviderGeneration();
    }

    expect(
      fields.db.prepare("SELECT model FROM memory_index_chunks WHERE path = ?").get(first.path)
        ?.model,
    ).toBe("fts-only");
    expect(
      fields.db.prepare("SELECT model FROM memory_index_chunks WHERE path = ?").get(second.path)
        ?.model,
    ).toBe("fts-only");
  });

  it("waits for admitted provider users before retirement", async () => {
    const cfg = createCfg({ provider: "openai" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
      embedQueryWithRetry: (text: string) => Promise<number[]>;
      retireCurrentProvider: () => Promise<void>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    let releaseFirstQuery: () => void = () => {};
    let markFirstQueryStarted: () => void = () => {};
    const firstQueryGate = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    const firstQueryStarted = new Promise<void>((resolve) => {
      markFirstQueryStarted = resolve;
    });
    fields.provider.embed = async () => {
      markFirstQueryStarted();
      await firstQueryGate;
      return [1, 0, 0, 0];
    };

    const queryPromise = fields.embedQueryWithRetry("alpha");
    await firstQueryStarted;
    const retirementPromise = fields.retireCurrentProvider();
    let retirementSettled = false;
    void retirementPromise.then(
      () => {
        retirementSettled = true;
      },
      () => {
        retirementSettled = true;
      },
    );
    try {
      await Promise.resolve();
      expect(retirementSettled).toBe(false);
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseFirstQuery();
    }

    await expect(queryPromise).resolves.toEqual([1, 0, 0, 0]);
    await retirementPromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("uses the leased provider runtime after retirement starts", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    type QueryProvider = {
      embed: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
    };
    const fields = manager as unknown as {
      provider: QueryProvider | null;
      providerRuntime?: { inlineQueryTimeoutMs?: number };
      acquireProviderUse: (provider: QueryProvider) => () => void;
      retireCurrentProvider: () => Promise<void>;
      embedQueryWithRetry: (
        text: string,
        signal: AbortSignal | undefined,
        provider: QueryProvider,
        markDegraded: boolean,
        providerRuntime: { inlineQueryTimeoutMs?: number },
      ) => Promise<number[]>;
    };
    await manager.probeEmbeddingAvailability();
    const provider = fields.provider;
    if (!provider) {
      throw new Error("Expected a test embedding provider");
    }
    const providerRuntime = { inlineQueryTimeoutMs: 10 };
    fields.providerRuntime = providerRuntime;
    provider.embed = async (_text, options) =>
      await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => resolve([1, 0, 0, 0]), 100);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("embedding aborted"));
          },
          { once: true },
        );
      });

    const releaseProvider = fields.acquireProviderUse(provider);
    const retirementPromise = fields.retireCurrentProvider();
    try {
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      await expect(
        fields.embedQueryWithRetry("alpha", undefined, provider, false, providerRuntime),
      ).rejects.toThrow("timed out");
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseProvider();
    }

    await retirementPromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for an admitted search before manager teardown", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      searchVector: () => Promise<unknown[]>;
      closing: boolean;
      closed: boolean;
    };
    let releaseVectorSearch: () => void = () => {};
    let markVectorSearchStarted: () => void = () => {};
    const vectorSearchGate = new Promise<void>((resolve) => {
      releaseVectorSearch = resolve;
    });
    const vectorSearchStarted = new Promise<void>((resolve) => {
      markVectorSearchStarted = resolve;
    });
    fields.searchVector = async () => {
      markVectorSearchStarted();
      await vectorSearchGate;
      return [];
    };

    const searchPromise = manager.search("alpha");
    await vectorSearchStarted;
    const closePromise = manager.close();
    let closeSettled = false;
    void closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    try {
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(fields.closing).toBe(true);
      expect(fields.closed).toBe(false);
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseVectorSearch();
    }

    await expect(searchPromise).resolves.toBeDefined();
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for an admitted vector probe before manager teardown", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    const fields = manager as unknown as {
      ensureVectorReady: () => Promise<boolean>;
    };
    let releaseProbe: () => void = () => {};
    let markProbeStarted: () => void = () => {};
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    fields.ensureVectorReady = async () => {
      markProbeStarted();
      await probeGate;
      return true;
    };

    const probePromise = manager.probeVectorAvailability();
    await probeStarted;
    const closePromise = manager.close();
    let closeSettled = false;
    void closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    try {
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseProbe();
    }

    await expect(probePromise).resolves.toBe(true);
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("fails closed when fallback initialization fails for an explicit provider", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerCreationFailure = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerFixture.providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries the optional primary after fallback initialization fails", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        id: string;
        embed: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerCreationFailure = "fallback-provider";
    const callsBeforeSearch = providerFixture.providerCalls.length;

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerFixture.providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toEqual(["fallback-provider", "openai"]);
    expect(fields.provider?.id).toBe("mock");
  });

  it("fails closed and retries a required primary after a null fallback result", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { embed: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerFixture.providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries an optional primary after a null fallback result", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { id: string; embed: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    providerFixture.providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerFixture.providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(fields.provider?.id).toBe("mock");
  });

  it("keeps concurrent optional searches in FTS mode when shared fallback fails", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
      } | null;
      ensureProviderInitialized: () => Promise<void>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };
    const ensureProviderInitialized = fields.ensureProviderInitialized.bind(manager);
    let providerInitializationCalls = 0;
    fields.ensureProviderInitialized = async () => {
      providerInitializationCalls += 1;
      await ensureProviderInitialized();
    };
    providerFixture.providerCreationFailure = "fallback-provider";
    let releaseProviderInit: () => void = () => {};
    providerFixture.providerInitGate = new Promise<void>((resolve) => {
      releaseProviderInit = resolve;
    });

    const callsBeforeSearch = providerFixture.providerCalls.length;
    const firstSearch = manager.search("alpha");
    await vi.waitFor(() =>
      expect(
        providerFixture.providerCalls.some((call) => call.provider === "fallback-provider"),
      ).toBe(true),
    );
    const initializationCallsBeforeSecondSearch = providerInitializationCalls;
    const secondSearch = manager.search("zebra");
    let secondSettled = false;
    void secondSearch.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    try {
      await vi.waitFor(() =>
        expect(providerInitializationCalls).toBeGreaterThan(initializationCallsBeforeSecondSearch),
      );
      expect(secondSettled).toBe(false);
      releaseProviderInit();
      const results = await Promise.all([firstSearch, secondSearch]);
      expect(results.every((result) => result.length > 0)).toBe(true);
      expect(
        providerFixture.providerCalls
          .slice(callsBeforeSearch)
          .filter((call) => call.provider === "fallback-provider"),
      ).toHaveLength(1);
    } finally {
      providerFixture.providerInitGate = null;
      releaseProviderInit();
      await Promise.allSettled([firstSearch, secondSearch]);
    }
  });
});
