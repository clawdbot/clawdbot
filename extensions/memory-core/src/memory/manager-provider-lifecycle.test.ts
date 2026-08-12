// Memory Core tests cover manager provider lifecycle availability behavior.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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

  it("caches embedding probe readiness across transient status managers", async () => {
    const cfg = createCfg({});
    const first = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    managersForCleanup.add(first);

    await expect(first.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(embedBatchCalls).toBe(1);
    await first.close();

    const second = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    managersForCleanup.add(second);

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
    expect(embedBatchCalls).toBe(1);

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
          embedQuery: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "local-model",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      close: async () => {},
    };

    (
      manager as unknown as {
        markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      }
    ).markLocalEmbeddingProviderDegraded(createLocalWorkerExitError());

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
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const fields = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embedQuery: (text: string) => Promise<number[]>;
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
    fields.markLocalEmbeddingProviderDegraded(createLocalWorkerExitError());
    await vi.waitFor(() => expect(providerCloseCalls).toBe(1));

    const callsBeforeFallback = providerCalls.length;
    const fallbackPromise = fields.activateFallbackProvider("local worker exited");
    try {
      await Promise.resolve();
      expect(providerCalls).toHaveLength(callsBeforeFallback);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
      await fallbackPromise;
    }
    expect(providerCalls.slice(callsBeforeFallback).map((call) => call.provider)).toEqual([
      "fallback-provider",
    ]);
  });

  it("retries failed provider retirement before fallback initialization", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    providerCloseFailuresRemaining = 1;
    const fields = manager as unknown as {
      activateFallbackProvider: (reason: string) => Promise<boolean>;
    };
    const callsBeforeFallback = providerCalls.length;

    await expect(fields.activateFallbackProvider("provider failed")).rejects.toThrow(
      "provider close failed",
    );
    expect(providerCalls).toHaveLength(callsBeforeFallback);

    await expect(fields.activateFallbackProvider("provider failed")).resolves.toBe(true);
    expect(providerCloseCalls).toBe(2);
    expect(providerCalls.slice(callsBeforeFallback).map((call) => call.provider)).toEqual([
      "fallback-provider",
    ]);
  });

  it("waits for provider shutdown before retry initialization", async () => {
    const cfg = createCfg({ provider: "openai" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    (
      manager as unknown as {
        resetProviderInitializationForRetry: () => void;
      }
    ).resetProviderInitializationForRetry();
    await vi.waitFor(() => expect(providerCloseCalls).toBe(1));

    const callsBeforeProbe = providerCalls.length;
    const probePromise = manager.probeEmbeddingAvailability();
    try {
      await Promise.resolve();
      expect(providerCalls).toHaveLength(callsBeforeProbe);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
      await probePromise;
    }
    expect(providerCalls.slice(callsBeforeProbe).map((call) => call.provider)).toEqual(["openai"]);
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
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const fields = manager as unknown as {
      provider: {
        embedQuery: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embedQuery = async () => {
      throw new Error("embedding provider failed");
    };

    const callsBeforeSearch = providerCalls.length;
    const searchPromise = manager.search("alpha");
    let concurrentSearch: ReturnType<typeof manager.search> = Promise.resolve([]);
    try {
      await vi.waitFor(() => expect(providerCloseCalls).toBe(1));
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
      expect(providerCalls).toHaveLength(callsBeforeSearch);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
      await Promise.allSettled([searchPromise, concurrentSearch]);
    }
    expect(providerCalls.slice(callsBeforeSearch).map((call) => call.provider)).toEqual([
      "fallback-provider",
    ]);
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
    managersForCleanup.add(manager);
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

    const callsBeforeFallback = providerCalls.length;
    const firstIndexPromise = fields.indexFile(
      {
        path: "memory/generation-race-first.md",
        absPath: path.join(memoryDir, "generation-race-first.md"),
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
        absPath: path.join(memoryDir, "generation-race-second.md"),
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
      fields.markLocalEmbeddingProviderDegraded(createLocalWorkerExitError());
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      fallbackPromise = fields.activateFallbackProvider("local worker exited");
      releaseFirstEmbedding();
      await firstIndexPromise;
      expect(providerCloseCalls).toBe(0);
      expect(providerCalls).toHaveLength(callsBeforeFallback);

      releaseSecondEmbedding();
      await fields.withTimeout(publicationStarted, 5_000, "publication did not start");
      expect(providerCloseCalls).toBe(0);
      expect(providerCalls).toHaveLength(callsBeforeFallback);

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

    expect(providerCalls.slice(callsBeforeFallback).map((call) => call.provider)).toEqual([
      "fallback-provider",
    ]);
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
