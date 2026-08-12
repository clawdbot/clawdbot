// Memory Core tests cover manager provider lifecycle lease behavior.
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

  it("keeps an active FTS-only generation stable while fallback activates", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "openai", fallback: "fallback-provider" }),
      "cli",
    );
    managersForCleanup.add(manager);
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
    fields.markLocalEmbeddingProviderDegraded(createLocalWorkerExitError());
    await vi.waitFor(() => {
      expect(fields.provider).toBeNull();
      expect(providerCloseCalls).toBe(1);
    });

    const createEntry = (name: string): IndexEntry => {
      const content = `# Log\n${name} FTS-only generation.`;
      return {
        path: `memory/${name}.md`,
        absPath: path.join(memoryDir, `${name}.md`),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(content),
        hash: hashText(content),
        content,
      };
    };
    const first = createEntry("fts-first");
    const second = createEntry("fts-second");

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
        embedQuery: (text: string) => Promise<number[]>;
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
    fields.provider.embedQuery = async () => {
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
      expect(providerCloseCalls).toBe(0);
    } finally {
      releaseFirstQuery();
    }

    await expect(queryPromise).resolves.toEqual([1, 0, 0, 0]);
    await retirementPromise;
    expect(providerCloseCalls).toBe(1);
  });

  it("uses the leased provider runtime after retirement starts", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "openai" }));
    type QueryProvider = {
      embedQuery: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
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
    provider.embedQuery = async (_text, options) =>
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
      expect(providerCloseCalls).toBe(0);
    } finally {
      releaseProvider();
    }

    await retirementPromise;
    expect(providerCloseCalls).toBe(1);
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
      expect(providerCloseCalls).toBe(0);
    } finally {
      releaseVectorSearch();
    }

    await expect(searchPromise).resolves.toBeDefined();
    await closePromise;
    expect(providerCloseCalls).toBe(1);
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
      expect(providerCloseCalls).toBe(0);
    } finally {
      releaseProbe();
    }

    await expect(probePromise).resolves.toBe(true);
    await closePromise;
    expect(providerCloseCalls).toBe(1);
  });

  it("fails closed when fallback initialization fails for an explicit provider", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
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
    providerCreationFailure = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries the optional primary after fallback initialization fails", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        id: string;
        embedQuery: (text: string) => Promise<number[]>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embedQuery = async () => {
      throw new Error("embedding provider failed");
    };
    providerCreationFailure = "fallback-provider";
    const callsBeforeSearch = providerCalls.length;

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerCreationFailure = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(providerCalls.slice(callsBeforeSearch).map((call) => call.provider)).toEqual([
      "fallback-provider",
      "openai",
    ]);
    expect(fields.provider?.id).toBe("mock");
  });

  it("fails closed and retries a required primary after a null fallback result", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { embedQuery: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embedQuery = async () => {
      throw new Error("embedding provider failed");
    };
    providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).rejects.toThrow(
      /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
  });

  it("retries an optional primary after a null fallback result", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: { id: string; embedQuery: (text: string) => Promise<number[]> } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embedQuery = async () => {
      throw new Error("embedding provider failed");
    };
    providerNullResult = "fallback-provider";

    await expect(manager.search("alpha")).resolves.toBeDefined();

    providerNullResult = null;
    await expect(manager.search("alpha")).resolves.toBeDefined();
    expect(fields.provider?.id).toBe("mock");
  });

  it("keeps concurrent optional searches in FTS mode when shared fallback fails", async () => {
    const cfg = createCfg({
      fallback: "fallback-provider",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      provider: {
        embedQuery: (text: string) => Promise<number[]>;
      } | null;
      ensureProviderInitialized: () => Promise<void>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.embedQuery = async () => {
      throw new Error("embedding provider failed");
    };
    const ensureProviderInitialized = fields.ensureProviderInitialized.bind(manager);
    let providerInitializationCalls = 0;
    fields.ensureProviderInitialized = async () => {
      providerInitializationCalls += 1;
      await ensureProviderInitialized();
    };
    providerCreationFailure = "fallback-provider";
    let releaseProviderInit: () => void = () => {};
    providerInitGate = new Promise<void>((resolve) => {
      releaseProviderInit = resolve;
    });

    const callsBeforeSearch = providerCalls.length;
    const firstSearch = manager.search("alpha");
    await vi.waitFor(() =>
      expect(providerCalls.some((call) => call.provider === "fallback-provider")).toBe(true),
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
        providerCalls
          .slice(callsBeforeSearch)
          .filter((call) => call.provider === "fallback-provider"),
      ).toHaveLength(1);
    } finally {
      providerInitGate = null;
      releaseProviderInit();
      await Promise.allSettled([firstSearch, secondSearch]);
    }
  });
});
