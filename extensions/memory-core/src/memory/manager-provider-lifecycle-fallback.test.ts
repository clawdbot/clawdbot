// Memory Core tests cover manager provider lifecycle fallback behavior.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import "./test-runtime-mocks.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

// This suite performs real sqlite/media indexing and can exceed the global
// timeout when it shares a packed CI extension shard.
vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

let embedBatchCalls = 0;
let embeddedBatchTexts: string[] = [];
let embedBatchInputCalls = 0;
let providerRuntimeBatchCalls: string[][] = [];
let providerRuntimeBatchGate: Promise<void> | null = null;
let providerRuntimeBatchErrors: unknown[] = [];
let providerRuntimeBatchFailuresRemaining = 0;
let providerRuntimeActiveBatchCalls = 0;
let providerRuntimeMaxActiveBatchCalls = 0;
let providerCloseCalls = 0;
let providerCloseFailuresRemaining = 0;
let providerCloseFailure: unknown = new Error("provider close failed");
let providerCreationFailure: string | null = null;
let providerNullResult: string | null = null;
let providerCloseGate: Promise<void> | null = null;
let providerInitGate: Promise<void> | null = null;
let providerCalls: Array<{ provider?: string; model?: string; outputDimensionality?: number }> = [];
let forceNoProvider = false;

const originalMemoryIndexStateDir = process.env.OPENCLAW_STATE_DIR;

const identityAliasFixture = vi.hoisted(() => ({
  provider: "identity-alias-test",
  canonicalModel: "hf:fixture/default-model.gguf",
  cacheModel: "/fixture/cache/default-model.gguf",
}));

function createLocalWorkerExitError(): Error {
  return Object.assign(new Error("Local embedding worker exited unexpectedly (exit code 134)"), {
    code: "LOCAL_EMBEDDING_WORKER_EXITED",
    reason: "exit",
    exitCode: 134,
  });
}

function setMemoryIndexStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreMemoryIndexStateDir(): void {
  if (originalMemoryIndexStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalMemoryIndexStateDir);
  }
}

vi.mock("./embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embeddings.js")>();
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    const image = lower.split("image").length - 1;
    const audio = lower.split("audio").length - 1;
    return [alpha, beta, image, audio];
  };
  return {
    ...actual,
    resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
      providerId === "gemini" || providerId === "fallback-provider"
        ? `${providerId}-embed`
        : fallbackSourceModel,
    resolveEmbeddingProviderAdapterId: (
      providerId: string,
      config?: {
        models?: {
          providers?: Record<string, { api?: string; baseUrl?: string; models?: unknown[] }>;
        };
      },
    ) => config?.models?.providers?.[providerId]?.api ?? providerId,
    resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
      providerId === "local" ? "local" : "remote",
    resolveEmbeddingProviderIndexIdentity: (options: { provider?: string; model?: string }) =>
      options.provider === identityAliasFixture.provider
        ? {
            provider: {
              id: identityAliasFixture.provider,
              model: identityAliasFixture.canonicalModel,
            },
            cacheKeyData: {
              provider: identityAliasFixture.provider,
              model: identityAliasFixture.canonicalModel,
            },
            aliases: [
              {
                model: identityAliasFixture.cacheModel,
                cacheKeyData: {
                  provider: identityAliasFixture.provider,
                  model: identityAliasFixture.cacheModel,
                },
              },
            ],
          }
        : undefined,
    createEmbeddingProvider: async (options: {
      provider?: string;
      model?: string;
      outputDimensionality?: number;
    }) => {
      providerCalls.push({
        provider: options.provider,
        model: options.model,
        outputDimensionality: options.outputDimensionality,
      });
      await providerInitGate;
      if (options.provider === providerCreationFailure) {
        throw new Error(`provider creation failed: ${options.provider}`);
      }
      if (options.provider === providerNullResult) {
        return {
          provider: null,
          requestedProvider: options.provider,
          providerUnavailableReason: `provider unavailable: ${options.provider}`,
        };
      }
      if (forceNoProvider) {
        return {
          provider: null,
          requestedProvider: options.provider ?? "auto",
          providerUnavailableReason: "No API key found for provider",
        };
      }
      const providerId =
        options.provider === "gemini" ||
        options.provider === "fallback-provider" ||
        options.provider === "batch-test" ||
        options.provider === "batch-wide-test" ||
        options.provider === identityAliasFixture.provider ||
        options.provider === "ollama"
          ? options.provider
          : "mock";
      const requestedModel = options.model ?? "mock-embed";
      const model =
        providerId === identityAliasFixture.provider &&
        (requestedModel === identityAliasFixture.canonicalModel ||
          requestedModel === identityAliasFixture.cacheModel)
          ? identityAliasFixture.canonicalModel
          : requestedModel;
      return {
        requestedProvider: options.provider ?? "openai",
        provider: {
          id: providerId,
          model,
          close: async () => {
            providerCloseCalls += 1;
            await providerCloseGate;
            if (providerCloseFailuresRemaining > 0) {
              providerCloseFailuresRemaining -= 1;
              throw providerCloseFailure;
            }
          },
          embedQuery: async (text: string) => embedText(text),
          embedBatch: async (texts: string[]) => {
            embedBatchCalls += 1;
            embeddedBatchTexts.push(...texts);
            return texts.map(embedText);
          },
          ...(providerId === "gemini" || providerId === "fallback-provider"
            ? {
                embedBatchInputs: async (
                  inputs: Array<{
                    text: string;
                    parts?: Array<
                      | { type: "text"; text: string }
                      | { type: "inline-data"; mimeType: string; data: string }
                    >;
                  }>,
                ) => {
                  embedBatchInputCalls += 1;
                  return inputs.map((input) => {
                    const inlineData = input.parts?.find((part) => part.type === "inline-data");
                    if (inlineData?.type === "inline-data" && inlineData.data.length > 9000) {
                      throw new Error("payload too large");
                    }
                    const mimeType =
                      inlineData?.type === "inline-data" ? inlineData.mimeType : undefined;
                    if (mimeType?.startsWith("image/")) {
                      return [0, 0, 1, 0];
                    }
                    if (mimeType?.startsWith("audio/")) {
                      return [0, 0, 0, 1];
                    }
                    return embedText(input.text);
                  });
                },
              }
            : {}),
        },
        ...(providerId === identityAliasFixture.provider
          ? {
              runtime: {
                id: providerId,
                cacheKeyData: {
                  provider: providerId,
                  model: identityAliasFixture.canonicalModel,
                },
                indexIdentityAliases: [
                  {
                    model: identityAliasFixture.cacheModel,
                    cacheKeyData: {
                      provider: providerId,
                      model: identityAliasFixture.cacheModel,
                    },
                  },
                ],
              },
            }
          : providerId === "batch-test" || providerId === "batch-wide-test"
            ? {
                runtime: {
                  id: providerId,
                  ...(providerId === "batch-wide-test" ? { sourceWideBatchEmbed: true } : {}),
                  batchEmbed: async (batch: { chunks: Array<{ text: string }> }) => {
                    providerRuntimeActiveBatchCalls += 1;
                    providerRuntimeMaxActiveBatchCalls = Math.max(
                      providerRuntimeMaxActiveBatchCalls,
                      providerRuntimeActiveBatchCalls,
                    );
                    try {
                      await providerRuntimeBatchGate;
                      providerRuntimeBatchCalls.push(batch.chunks.map((chunk) => chunk.text));
                      if (providerRuntimeBatchErrors.length > 0) {
                        throw providerRuntimeBatchErrors.shift();
                      }
                      if (providerRuntimeBatchFailuresRemaining > 0) {
                        providerRuntimeBatchFailuresRemaining -= 1;
                        throw new Error("provider runtime batch failed");
                      }
                      return batch.chunks.map((chunk) => embedText(chunk.text));
                    } finally {
                      providerRuntimeActiveBatchCalls -= 1;
                    }
                  },
                },
              }
            : providerId === "gemini" || providerId === "fallback-provider"
              ? {
                  runtime: {
                    id: providerId,
                    cacheKeyData: {
                      provider: providerId,
                      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                      model,
                      outputDimensionality: options.outputDimensionality,
                      headers: [],
                    },
                  },
                }
              : {}),
      };
    },
  };
});

describe("memory index", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";

  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
  });

  afterAll(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetMemoryCoreDreamingStateForTests();
    clearRegistry();
    managersForCleanup.clear();
    restoreMemoryIndexStateDir();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    clearRegistry();
    embedBatchCalls = 0;
    embeddedBatchTexts = [];
    embedBatchInputCalls = 0;
    providerRuntimeBatchCalls = [];
    providerRuntimeBatchGate = null;
    providerRuntimeBatchErrors = [];
    providerRuntimeBatchFailuresRemaining = 0;
    providerRuntimeActiveBatchCalls = 0;
    providerRuntimeMaxActiveBatchCalls = 0;
    providerCloseCalls = 0;
    providerCloseFailuresRemaining = 0;
    providerCloseFailure = new Error("provider close failed");
    providerCreationFailure = null;
    providerNullResult = null;
    providerCloseGate = null;
    providerInitGate = null;
    providerCalls = [];
    forceNoProvider = false;

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
    setMemoryIndexStateDir(path.join(workspaceDir, ".state-memory-index"));
    await configureMemoryCoreDreamingStateForTests();
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  function resetManagerForTest(manager: MemoryIndexManager) {
    // These tests reuse managers for performance. Clear the index + embedding
    // cache to keep each test fully isolated.
    const db = (
      manager as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => { get: (name: string) => { name?: string } | undefined };
        };
      }
    ).db;
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_embedding_cache",
      "memory_index_chunks_fts",
      "memory_index_chunks_vec",
    ]) {
      const existingTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (existingTable?.name === table) {
        db.exec(`DELETE FROM ${table}`);
      }
    }
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
    (manager as unknown as { sessionsDirtyFiles: Set<string> }).sessionsDirtyFiles.clear();
  }

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(params: {
    extraPaths?: string[];
    sources?: Array<"memory" | "sessions">;
    sessionMemory?: boolean;
    rememberAcrossConversations?: boolean;
    provider?: string;
    fallback?: "none" | "gemini" | "fallback-provider";
    providerAliases?: NonNullable<NonNullable<TestCfg["models"]>["providers"]>;
    batchEnabled?: boolean;
    model?: string;
    outputDimensionality?: number;
    multimodal?: {
      enabled?: boolean;
      modalities?: Array<"image" | "audio" | "all">;
      maxFileBytes?: number;
    };
    vectorEnabled?: boolean;
    cacheEnabled?: boolean;
    minScore?: number;
    onSearch?: boolean;
    hybrid?: {
      enabled: boolean;
      vectorWeight?: number;
      textWeight?: number;
      temporalDecay?: { enabled: boolean };
    };
  }): TestCfg {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          model: params.model ?? "mock-embed",
          fallback: params.fallback,
          outputDimensionality: params.outputDimensionality,
          store: {
            vector: params.vectorEnabled !== undefined ? { enabled: params.vectorEnabled } : {},
          },
          remote: params.batchEnabled
            ? {
                batch: { enabled: true },
              }
            : undefined,
          query: { minScore: params.minScore ?? 0 },
          cache: params.cacheEnabled ? { enabled: true } : undefined,
          extraPaths: params.extraPaths,
          multimodal: params.multimodal,
          sources: params.sources,
          rememberAcrossConversations:
            params.rememberAcrossConversations ?? params.sessionMemory ?? false,
        },
      },

      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
      models: params.providerAliases ? { providers: params.providerAliases } : undefined,
    });
  }

  function requireManager(
    result: Awaited<ReturnType<typeof getMemorySearchManager>>,
    missingMessage = "manager missing",
  ): MemoryIndexManager {
    if (!result.manager) {
      throw new Error(missingMessage);
    }
    return result.manager as unknown as MemoryIndexManager;
  }

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager;
  }

  async function getFreshManager(
    cfg: TestCfg,
    purpose?: "default" | "status" | "cli",
  ): Promise<MemoryIndexManager> {
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main", purpose }));
    managersForCleanup.add(manager);
    return manager;
  }

  it("does not activate fallback during search when index identity is already mismatched", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test" });
    const callsBeforeSearch = providerCalls.length;
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
        throw createLocalWorkerExitError();
      },
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
      close: async () => {},
    };

    const results = await manager.search("alpha");

    expect(results).toStrictEqual([]);
    expect(providerCalls.slice(callsBeforeSearch)).toStrictEqual([]);
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
          throw createLocalWorkerExitError();
        },
        embedBatch: async () => {
          throw createLocalWorkerExitError();
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
        throw createLocalWorkerExitError();
      },
      embedBatch: async () => {
        throw createLocalWorkerExitError();
      },
      close: async () => {},
    };
    const callsBeforeSearch = providerCalls.length;

    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embedding worker exited"),
    });

    const results = await manager.search("alpha");

    expect(results.length).toBeGreaterThan(0);
    expect(providerCalls.slice(callsBeforeSearch).map((call) => call.provider)).toContain("openai");
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
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    const manager = await getRequiredMemoryIndexManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });
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
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    const manager = await getRequiredMemoryIndexManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });
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
    forceNoProvider = true;

    const cfg = createCfg({
      provider: "openai",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const manager = await getFreshManager(cfg);
    try {
      await expect(manager.search("Alpha")).rejects.toThrow(
        /Memory search unavailable: embedding provider "openai" is configured but unavailable\.[\s\S]*agentId=main purpose=default[\s\S]*registeredMemoryEmbeddingProviders=none/,
      );
      await expect(manager.sync({ reason: "test" })).rejects.toThrow(
        /Memory sync unavailable: embedding provider "openai" is configured but unavailable\./,
      );
      forceNoProvider = false;
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
