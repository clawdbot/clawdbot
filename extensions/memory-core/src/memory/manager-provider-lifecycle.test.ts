// Memory Core tests cover manager provider lifecycle availability behavior.
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
  const {
    createConfig: createCfg,
    getFreshManager,
    getPersistentManager,
    requireManager,
    trackManager,
  } = fixture;

  it("caches embedding probe readiness across transient status managers", async () => {
    const cfg = createCfg({});
    const first = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(first);

    await expect(first.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(providerFixture.embedBatchCalls).toBe(1);
    await first.close();

    const second = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(second);

    const cachedBeforeProbe = second.getCachedEmbeddingAvailability?.();
    expect(cachedBeforeProbe?.ok).toBe(true);
    expect(cachedBeforeProbe?.checked).toBe(true);
    expect(cachedBeforeProbe?.cached).toBe(true);
    expect(cachedBeforeProbe?.checkedAtMs).toBeTypeOf("number");
    expect(cachedBeforeProbe?.cacheExpiresAtMs).toBeTypeOf("number");
    if (
      typeof cachedBeforeProbe?.checkedAtMs === "number" &&
      typeof cachedBeforeProbe.cacheExpiresAtMs === "number"
    ) {
      expect(cachedBeforeProbe.cacheExpiresAtMs - cachedBeforeProbe.checkedAtMs).toBe(30_000);
    }
    await expect(second.probeEmbeddingAvailability()).resolves.toStrictEqual({
      ok: true,
      checked: true,
      cached: true,
      checkedAtMs: cachedBeforeProbe?.checkedAtMs,
      cacheExpiresAtMs: cachedBeforeProbe?.cacheExpiresAtMs,
    });
    expect(providerFixture.embedBatchCalls).toBe(1);

    const cached = second.getCachedEmbeddingAvailability?.();
    expect((cached?.cacheExpiresAtMs ?? 0) - (cached?.checkedAtMs ?? 0)).toBe(30_000);
  });

  it("clears cached embedding probe readiness when local embeddings degrade", async () => {
    const cfg = createCfg({});
    const manager = await getPersistentManager(cfg);

    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(manager.getCachedEmbeddingAvailability()?.ok).toBe(true);
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embed: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "local-model",
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      close: async () => {},
    };

    (
      manager as unknown as {
        markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      }
    ).markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());

    expect(manager.getCachedEmbeddingAvailability()).toBeNull();
    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embeddings degraded"),
    });
  });

  it("waits for degraded provider shutdown before fallback initialization", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const fields = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embed: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      } | null;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.id = "local";
    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));

    const callsBeforeFallback = providerFixture.providerCalls.length;
    const fallbackPromise = fields.activateFallbackProvider("local worker exited");
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await fallbackPromise;
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
  });

  it("retries failed provider retirement before fallback initialization", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    providerFixture.providerCloseFailuresRemaining = 1;
    const fields = manager as unknown as {
      activateFallbackProvider: (reason: string) => Promise<boolean>;
    };
    const callsBeforeFallback = providerFixture.providerCalls.length;

    await expect(fields.activateFallbackProvider("provider failed")).rejects.toThrow(
      "provider close failed",
    );
    expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

    await expect(fields.activateFallbackProvider("provider failed")).resolves.toBe(true);
    expect(providerFixture.providerCloseCalls).toBe(2);
    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
  });

  it("waits for provider shutdown before retry initialization", async () => {
    const cfg = createCfg({ provider: "openai" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    (
      manager as unknown as {
        resetProviderInitializationForRetry: () => void;
      }
    ).resetProviderInitializationForRetry();
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));

    const callsBeforeProbe = providerFixture.providerCalls.length;
    const probePromise = manager.probeEmbeddingAvailability();
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeProbe);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await probePromise;
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeProbe).map((call) => call.provider),
    ).toEqual(["openai"]);
  });

  it("waits for active provider shutdown before fallback initialization", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
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

    const callsBeforeSearch = providerFixture.providerCalls.length;
    const searchPromise = manager.search("alpha");
    let concurrentSearch: ReturnType<typeof manager.search> = Promise.resolve([]);
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      concurrentSearch = manager.search("zebra");
      let concurrentSettled = false;
      void concurrentSearch.then(
        () => {
          concurrentSettled = true;
        },
        () => {
          concurrentSettled = true;
        },
      );
      await Promise.resolve();
      expect(concurrentSettled).toBe(false);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeSearch);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await Promise.allSettled([searchPromise, concurrentSearch]);
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
    await expect(concurrentSearch).resolves.toBeDefined();
  });

  it("leases the indexing provider generation through chunk publication", async () => {
    const manager = await getFreshManager(
      createCfg({
        provider: "openai",
        fallback: "fallback-provider",
        cacheEnabled: true,
        hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
      }),
      "cli",
    );
    trackManager(manager);
    const fields = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embedBatch: (texts: string[]) => Promise<number[][]>;
      } | null;
      providerKey: string;
      computeProviderKey: () => string;
      ensureProviderInitialized: () => Promise<void>;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
      indexFile: (
        entry: {
          path: string;
          absPath: string;
          mtimeMs: number;
          size: number;
          hash: string;
          content: string;
        },
        options: { source: "memory"; content: string },
      ) => Promise<void>;
      ensureVectorReady: (dimensions?: number) => Promise<boolean>;
      db: {
        prepare: (sql: string) => {
          get: (
            ...params: unknown[]
          ) => { model?: string; provider?: string; provider_key?: string } | undefined;
        };
      };
    };
    await fields.ensureProviderInitialized();
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    const indexedProvider = fields.provider;
    indexedProvider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    const indexedProviderKey = fields.providerKey;
    const firstContent = "# Log\nFirst memory line indexed during provider fallback.";
    const secondContent = "# Log\nSecond memory line indexed during provider fallback.";
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-first.md"), firstContent);
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-second.md"), secondContent);

    let releaseFirstEmbedding: () => void = () => {};
    let releaseSecondEmbedding: () => void = () => {};
    let markFirstEmbeddingStarted: () => void = () => {};
    let markSecondEmbeddingStarted: () => void = () => {};
    const firstEmbeddingGate = new Promise<void>((resolve) => {
      releaseFirstEmbedding = resolve;
    });
    const secondEmbeddingGate = new Promise<void>((resolve) => {
      releaseSecondEmbedding = resolve;
    });
    const firstEmbeddingStarted = new Promise<void>((resolve) => {
      markFirstEmbeddingStarted = resolve;
    });
    const secondEmbeddingStarted = new Promise<void>((resolve) => {
      markSecondEmbeddingStarted = resolve;
    });
    indexedProvider.embedBatch = async (texts) => {
      if (texts.some((text) => text.includes("First"))) {
        markFirstEmbeddingStarted();
        await firstEmbeddingGate;
      } else {
        markSecondEmbeddingStarted();
        await secondEmbeddingGate;
      }
      return texts.map(() => [1, 0, 0, 0]);
    };
    let releasePublication: () => void = () => {};
    let markPublicationStarted: () => void = () => {};
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publicationStarted = new Promise<void>((resolve) => {
      markPublicationStarted = resolve;
    });
    const ensureVectorReady = fields.ensureVectorReady.bind(manager);
    let publicationCalls = 0;
    fields.ensureVectorReady = async (dimensions) => {
      publicationCalls += 1;
      if (publicationCalls === 1) {
        return await ensureVectorReady(dimensions);
      }
      markPublicationStarted();
      await publicationGate;
      return await ensureVectorReady(dimensions);
    };

    const callsBeforeFallback = providerFixture.providerCalls.length;
    const firstIndexPromise = fields.indexFile(
      {
        path: "memory/generation-race-first.md",
        absPath: path.join(fixture.paths.memory, "generation-race-first.md"),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(firstContent),
        hash: hashText(firstContent),
        content: firstContent,
      },
      { source: "memory", content: firstContent },
    );
    const secondIndexPromise = fields.indexFile(
      {
        path: "memory/generation-race-second.md",
        absPath: path.join(fixture.paths.memory, "generation-race-second.md"),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(secondContent),
        hash: hashText(secondContent),
        content: secondContent,
      },
      { source: "memory", content: secondContent },
    );
    let fallbackPromise: Promise<boolean> | null = null;
    try {
      await fields.withTimeout(
        Promise.all([firstEmbeddingStarted, secondEmbeddingStarted]),
        5_000,
        "concurrent embeddings did not start",
      );
      fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      fallbackPromise = fields.activateFallbackProvider("local worker exited");
      releaseFirstEmbedding();
      await firstIndexPromise;
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      releaseSecondEmbedding();
      await fields.withTimeout(publicationStarted, 5_000, "publication did not start");
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      releasePublication();
      await secondIndexPromise;
      await expect(fallbackPromise).resolves.toBe(true);
    } finally {
      releaseFirstEmbedding();
      releaseSecondEmbedding();
      releasePublication();
      await Promise.allSettled([
        firstIndexPromise,
        secondIndexPromise,
        ...(fallbackPromise ? [fallbackPromise] : []),
      ]);
    }

    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
    expect(
      fields.db
        .prepare("SELECT model FROM memory_index_chunks WHERE path = ?")
        .get("memory/generation-race-second.md")?.model,
    ).toBe(indexedProvider.model);
    expect(
      fields.db
        .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache LIMIT 1")
        .get(),
    ).toEqual({
      provider: indexedProvider.id,
      model: indexedProvider.model,
      provider_key: indexedProviderKey,
    });
  });
});
