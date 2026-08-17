// Memory Core tests cover manager provider lifecycle fallback behavior.
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, getPersistentManager } = fixture;

  it("does not activate fallback during search when index identity is already mismatched", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test" });
    const callsBeforeSearch = providerFixture.providerCalls.length;
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embedQuery: () => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "mock-embed",
      embedQuery: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };

    const results = await manager.search("alpha");

    expect(results).toStrictEqual([]);
    expect(providerFixture.providerCalls.slice(callsBeforeSearch)).toStrictEqual([]);
    expect(
      (
        manager as unknown as {
          provider: { id: string } | null;
        }
      ).provider?.id,
    ).toBe("local");
  });

  it("rebuilds with fallback provider during explicit identity repair", async () => {
    const oldCfg = createCfg({
      model: "old-embed",
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    const cfg = createCfg({
      model: "new-embed",
      fallback: "fallback-provider",
    });
    const manager = await getFreshManager(cfg);
    try {
      expect(manager.status().dirty).toBe(true);
      const fields = manager as unknown as {
        providerInitialized: boolean;
        provider: {
          id: string;
          model: string;
          embedQuery: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      };
      fields.providerInitialized = true;
      fields.provider = {
        id: "mock",
        model: "new-embed",
        embedQuery: async () => {
          throw providerFixture.createLocalWorkerExitError();
        },
        embedBatch: async () => {
          throw providerFixture.createLocalWorkerExitError();
        },
        close: async () => {},
      };

      await manager.sync({ reason: "cli" });

      expect(manager.status().dirty).toBe(false);
      expect(manager.status().provider).toBe("fallback-provider");
      expect(manager.status().model).toBe("fallback-provider-embed");
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      await expect(manager.search("alpha")).resolves.not.toStrictEqual([]);
    } finally {
      await manager.close?.();
    }
  });

  it("reinitializes the configured provider after probe-time local degradation", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test" });
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embedQuery: () => Promise<number[]>;
          embedBatch: () => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "mock-embed",
      embedQuery: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      embedBatch: async () => {
        throw providerFixture.createLocalWorkerExitError();
      },
      close: async () => {},
    };
    const callsBeforeSearch = providerFixture.providerCalls.length;

    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embedding worker exited"),
    });

    const results = await manager.search("alpha");

    expect(results.length).toBeGreaterThan(0);
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toContain("openai");
    expect(
      (
        manager as unknown as {
          provider: { id: string } | null;
        }
      ).provider?.id,
    ).toBe("mock");
  });

  it("clears identity dirty after status resolves the indexed fallback provider", async () => {
    const indexedCfg = createCfg({
      provider: "fallback-provider",
      model: "new-embed",
    });
    const indexedManager = await getFreshManager(indexedCfg);
    await indexedManager.sync({ reason: "test", force: true });
    await indexedManager.close?.();

    const cfg = createCfg({
      fallback: "fallback-provider",
      model: "new-embed",
    });
    const manager = await getFreshManager(cfg, "status");
    try {
      expect(manager.status().dirty).toBe(true);

      const fields = manager as unknown as {
        provider: {
          id: string;
          model: string;
          embedQuery: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
        providerInitialized: boolean;
        providerRuntime: {
          id: string;
          cacheKeyData: Record<string, unknown>;
        };
        providerKey: string;
        computeProviderKey: () => string;
      };
      fields.provider = {
        id: "fallback-provider",
        model: "new-embed",
        embedQuery: async () => [1, 0, 0, 0],
        embedBatch: async (texts) => texts.map(() => [1, 0, 0, 0]),
        close: async () => {},
      };
      fields.providerRuntime = {
        id: "fallback-provider",
        cacheKeyData: {
          provider: "fallback-provider",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          model: "new-embed",
          headers: [],
        },
      };
      fields.providerInitialized = true;
      fields.providerKey = fields.computeProviderKey();

      expect(manager.status().dirty).toBe(false);
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await manager.close?.();
    }
  });

  it("exposes already-created local runtime facts without probing embeddings", async () => {
    const cfg = createCfg({});
    const manager = await getFreshManager(cfg, "status");
    try {
      const getRuntimeFacts = vi.fn(() => ({
        engine: "llama.cpp" as const,
        state: "ready" as const,
        backend: "cuda" as const,
        buildType: "prebuilt" as const,
        deviceNames: ["NVIDIA Test GPU"],
        offload: {
          supported: true,
          offloadedLayers: 24,
          totalLayers: 24,
        },
        context: {
          requestedSize: 4096,
        },
      }));
      const provider = {
        id: "local",
        model: "test-model.gguf",
        embedQuery: vi.fn(async () => [1, 0, 0, 0]),
        embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0, 0])),
      };
      Object.defineProperty(provider, Symbol.for("openclaw.localEmbeddingRuntimeFacts"), {
        value: getRuntimeFacts,
      });
      const fields = manager as unknown as {
        provider: typeof provider | null;
      };
      fields.provider = provider;

      expect(manager.status().custom?.llamaCppRuntime).toMatchObject({
        state: "ready",
        backend: "cuda",
        deviceNames: ["NVIDIA Test GPU"],
        offload: {
          offloadedLayers: 24,
          totalLayers: 24,
        },
        context: {
          requestedSize: 4096,
        },
      });
      expect(getRuntimeFacts).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close?.();
    }
  });

  it("fails fast instead of searching FTS when an explicit provider is unavailable", async () => {
    providerFixture.forceNoProvider = true;

    const cfg = createCfg({
      provider: "openai",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const manager = await getFreshManager(cfg);
    try {
      await expect(manager.search("Alpha")).rejects.toThrow(
        /Memory search unavailable: embedding provider "openai" is configured but unavailable\.[\s\S]*agentId=main purpose=default[\s\S]*registeredMemoryEmbeddingProviders=openai-compatible/,
      );
      await expect(manager.sync({ reason: "test" })).rejects.toThrow(
        /Memory sync unavailable: embedding provider "openai" is configured but unavailable\./,
      );
      providerFixture.forceNoProvider = false;
      await manager.sync({ reason: "test", force: true });
      const results = await manager.search("Alpha");
      expect(results.length).toBeGreaterThan(0);
    } finally {
      await manager.close?.();
    }
  });

  it("fails fast instead of returning FTS when an explicit provider is lost at runtime", async () => {
    const cfg = createCfg({
      provider: "openai",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test", force: true });
      (
        manager as unknown as {
          provider: null;
        }
      ).provider = null;

      await expect(manager.search("Alpha")).rejects.toThrow(
        /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
      );
    } finally {
      await manager.close?.();
    }
  });
});
