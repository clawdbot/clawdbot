// Memory Core tests cover index plugin behavior.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  formatSqliteSessionFileMarker,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { closeMemoryIndexManagersForAgent } from "./manager.js";

// This suite performs real sqlite/media indexing and can exceed the global
// timeout when it shares a packed CI extension shard.
vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

let embedBatchCalls = 0;
let embedBatchInputCalls = 0;
let providerRuntimeBatchCalls: string[][] = [];
let providerRuntimeBatchGate: Promise<void> | null = null;
let providerRuntimeBatchErrors: unknown[] = [];
let providerRuntimeBatchFailuresRemaining = 0;
let providerRuntimeActiveBatchCalls = 0;
let providerRuntimeMaxActiveBatchCalls = 0;
let providerCloseCalls = 0;
let providerCloseFailuresRemaining = 0;
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

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    const image = lower.split("image").length - 1;
    const audio = lower.split("audio").length - 1;
    return [alpha, beta, image, audio];
  };
  return {
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
              throw new Error("provider close failed");
            }
          },
          embedQuery: async (text: string) => embedText(text),
          embedBatch: async (texts: string[]) => {
            embedBatchCalls += 1;
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
    clearRegistry();
    managersForCleanup.clear();
    restoreMemoryIndexStateDir();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    clearRegistry();
    embedBatchCalls = 0;
    embedBatchInputCalls = 0;
    providerRuntimeBatchCalls = [];
    providerRuntimeBatchGate = null;
    providerRuntimeBatchErrors = [];
    providerRuntimeBatchFailuresRemaining = 0;
    providerRuntimeActiveBatchCalls = 0;
    providerRuntimeMaxActiveBatchCalls = 0;
    providerCloseCalls = 0;
    providerCloseFailuresRemaining = 0;
    providerCloseGate = null;
    providerInitGate = null;
    providerCalls = [];
    forceNoProvider = false;

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
    setMemoryIndexStateDir(path.join(workspaceDir, ".state-memory-index"));
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
    return {
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
    };
  }

  async function seedMemoryIndexSessionTranscript(params: {
    messages: Array<{
      content: string;
      role: "assistant" | "user";
      timestamp: number | string;
    }>;
    sessionId: string;
    sessionKey?: string;
  }): Promise<void> {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = params.sessionKey ?? `agent:main:memory:${params.sessionId}`;
    // Message timestamps are behavioral inputs; entry freshness only keeps the
    // fixture out of real session-retention maintenance as wall time advances.
    const updatedAt = Date.now();
    await fs.mkdir(sessionsDir, { recursive: true });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: params.sessionId,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: params.sessionId,
          storePath,
        }),
        updatedAt,
      },
    });
    for (const message of params.messages) {
      await appendSessionTranscriptMessageByIdentity({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey,
        storePath,
        message: {
          role: message.role,
          timestamp: message.timestamp,
          content: [{ type: "text", text: message.content }],
        },
      });
    }
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
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    return await getRequiredMemoryIndexManager({ cfg, agentId: "main", purpose });
  }

  function rewritePersistedProviderIdentity(manager: MemoryIndexManager, model: string): void {
    const providerKey = hashText(
      JSON.stringify({
        provider: identityAliasFixture.provider,
        model,
      }),
    );
    const db = Reflect.get(manager, "db") as {
      prepare: (sql: string) => {
        get: (...params: unknown[]) => { value?: string } | undefined;
        run: (...params: unknown[]) => void;
      };
    };
    const metaRow = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get("memory_index_meta_v1");
    const meta = JSON.parse(metaRow?.value ?? "{}") as MemoryIndexMeta;
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?").run(
      JSON.stringify({ ...meta, model, providerKey }),
      "memory_index_meta_v1",
    );
    db.prepare("UPDATE memory_index_chunks SET model = ?").run(model);
    db.prepare(
      "UPDATE memory_embedding_cache SET model = ?, provider_key = ? WHERE provider = ?",
    ).run(model, providerKey, identityAliasFixture.provider);
  }

  async function expectHybridKeywordSearchFindsMemory(cfg: TestCfg) {
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

  it("does not prepare vector deletes after in-place reset drops a missing vector table", async () => {
    const cfg = createCfg({
      vectorEnabled: true,
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    managersForCleanup.add(manager);
    type VectorState = { available: boolean | null; dims?: number };
    const vector = Reflect.get(manager, "vector") as VectorState;
    vector.available = true;
    vector.dims = 4;
    Reflect.set(manager, "vectorReady", Promise.resolve(true));

    await expect(
      Reflect.apply(Reflect.get(manager, "runInPlaceReindex"), manager, [
        { reason: "test", force: true },
      ]),
    ).resolves.toBeUndefined();
  });

  async function getFtsSessionManager(params: {
    stateDirName: string;
  }): Promise<MemoryIndexManager | null> {
    forceNoProvider = true;
    setMemoryIndexStateDir(path.join(workspaceDir, params.stateDirName));
    const cfg = createCfg({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager.status().fts?.available ? manager : null;
  }

  it("indexes memory files and searches", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });
      const results = await manager.search("alpha");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      const status = manager.status();
      expect(status.sourceCounts).toStrictEqual([
        {
          source: "memory",
          files: status.files,
          chunks: status.chunks,
        },
      ]);
    } finally {
      await manager.close?.();
    }
  });

  it("keeps existing file index rows when chunk publication fails", async () => {
    const cfg = createCfg({});
    const manager = await getFreshManager(cfg);
    try {
      const db = Reflect.get(manager, "db") as DatabaseSync;

      await manager.sync({ reason: "test" });

      const initialSource = db
        .prepare("SELECT hash FROM memory_index_sources WHERE path LIKE ? AND source = ?")
        .get("%2026-01-12.md", "memory") as { hash: string } | undefined;
      const initialChunk = db
        .prepare("SELECT text FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
        .get("%2026-01-12.md", "memory") as { text: string } | undefined;
      expect(initialSource?.hash).toBeTruthy();
      expect(initialChunk?.text).toContain("Alpha memory line.");

      db.exec(`
        CREATE TRIGGER fail_chunk_publication
        AFTER INSERT ON memory_index_chunks
        BEGIN
          SELECT RAISE(FAIL, 'forced chunk publication failure');
        END;
      `);
      await fs.writeFile(path.join(memoryDir, "2026-01-12.md"), "# Log\nUpdated memory line.");
      Reflect.set(manager, "dirty", true);

      await expect(manager.sync({ reason: "test" })).rejects.toThrow(
        "forced chunk publication failure",
      );

      expect(
        db
          .prepare("SELECT hash FROM memory_index_sources WHERE path LIKE ? AND source = ?")
          .get("%2026-01-12.md", "memory"),
      ).toEqual(initialSource);
      expect(
        db
          .prepare("SELECT text FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
          .get("%2026-01-12.md", "memory"),
      ).toEqual(initialChunk);
    } finally {
      await manager.close?.();
    }
  });

  it("reindexes memory tables in place without deleting unrelated agent rows", async () => {
    const stateDir = path.join(workspaceDir, "managed-memory-state");
    setMemoryIndexStateDir(stateDir);
    const agentDbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const agentDb = openOpenClawAgentDatabase({ agentId: "main" });
    agentDb.db
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("test", "keep-me", JSON.stringify({ value: "keep-me" }), 1);
    closeOpenClawAgentDatabasesForTest();

    const manager = await getFreshManager(
      createCfg({
        hybrid: { enabled: false },
      }),
    );
    try {
      await manager.sync({ reason: "test", force: true });
      expect(manager.status().dbPath).toBe(agentDbPath);
    } finally {
      await manager.close?.();
    }

    const reopened = openOpenClawAgentDatabase({ agentId: "main" });
    expect(
      reopened.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("test", "keep-me"),
    ).toEqual({
      value_json: JSON.stringify({ value: "keep-me" }),
    });
  });

  it("initializes agent schema metadata when memory opens the database first", async () => {
    const manager = await getFreshManager(createCfg({}));
    await manager.close?.();

    const agentDb = openOpenClawAgentDatabase({ agentId: "main" });
    expect(
      agentDb.db.prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({
      role: "agent",
      agent_id: "main",
    });
  });

  it("batches dirty memory chunks across files", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
    await fs.writeFile(path.join(memoryDir, "2026-01-14.md"), "# Log\nGamma memory line.");
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(1);
      expect(providerRuntimeBatchCalls[0]).toEqual([
        "# Log\nAlpha memory line.\nZebra memory line.",
        "# Log\nBeta memory line.",
        "# Log\nGamma memory line.",
      ]);
    } finally {
      await manager.close?.();
    }
  });

  it("maps source-wide batch fallback results to missing chunks after cache hits", async () => {
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });

      await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
      providerRuntimeBatchCalls = [];
      providerRuntimeBatchFailuresRemaining = 1;
      embedBatchCalls = 0;

      await manager.sync({ reason: "test", force: true });

      expect(providerRuntimeBatchCalls).toEqual([["# Log\nBeta memory line."]]);
      expect(embedBatchCalls).toBe(1);
      const betaRow = (
        manager as unknown as {
          db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
        }
      ).db
        .prepare("SELECT embedding FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
        .get("%2026-01-13.md", "memory") as { embedding: string } | undefined;

      expect(betaRow).toBeDefined();
      expect(JSON.parse(betaRow?.embedding ?? "[]")).toEqual([0, 1, 0, 0]);
    } finally {
      await manager.close?.();
    }
  });

  it("derives batch attempts locally instead of trusting provider error metadata", async () => {
    providerRuntimeBatchErrors = [
      Object.assign(new Error("provider runtime batch failed"), {
        batchAttempts: Number.MAX_SAFE_INTEGER,
      }),
    ];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(1);
      expect(embedBatchCalls).toBe(1);
      expect(manager.status().batch).toMatchObject({
        enabled: true,
        failures: 1,
        lastError: "provider runtime batch failed",
      });
    } finally {
      await manager.close?.();
    }
  });

  it("disables batch immediately when the provider reports it unavailable", async () => {
    providerRuntimeBatchErrors = [
      Object.assign(new Error("provider batch unavailable"), {
        code: "embedding_batch_unavailable",
      }),
    ];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(1);
      expect(embedBatchCalls).toBe(1);
      expect(manager.status().batch).toMatchObject({
        enabled: false,
        failures: 2,
        lastError: "provider batch unavailable",
      });
    } finally {
      await manager.close?.();
    }
  });

  it.each([
    ["frozen errors", Object.freeze(new Error("provider runtime retry failed"))],
    ["primitive rejections", "provider runtime retry failed"],
  ])("preserves %s while recording both attempts", async (_kind, retryError) => {
    providerRuntimeBatchErrors = [new Error("memory embeddings batch timed out"), retryError];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(2);
      expect(embedBatchCalls).toBe(1);
      expect(manager.status().batch).toMatchObject({
        enabled: false,
        failures: 2,
        lastError: "provider runtime retry failed",
      });
    } finally {
      await manager.close?.();
    }
  });

  it("resets batch failures when a timeout retry recovers", async () => {
    providerRuntimeBatchErrors = [new Error("provider runtime batch failed")];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    try {
      await manager.sync({ reason: "test" });
      expect(manager.status().batch?.failures).toBe(1);

      await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
      providerRuntimeBatchCalls = [];
      providerRuntimeBatchErrors = [new Error("memory embeddings batch timed out")];
      embedBatchCalls = 0;

      await manager.sync({ reason: "test", force: true });

      expect(providerRuntimeBatchCalls).toHaveLength(2);
      expect(embedBatchCalls).toBe(0);
      expect(manager.status().batch).toMatchObject({
        enabled: true,
        failures: 0,
        lastError: undefined,
      });
    } finally {
      await manager.close?.();
    }
  });

  it("keeps split chunks from oversized files in one source-wide batch", async () => {
    await fs.writeFile(
      path.join(memoryDir, "2026-01-13.md"),
      `# Log\n${"Long split memory line. ".repeat(1200)}`,
    );
    await fs.writeFile(path.join(memoryDir, "2026-01-14.md"), "# Log\nBeta memory line.");
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(1);
      const combinedBatch = providerRuntimeBatchCalls[0] ?? [];
      expect(combinedBatch.length).toBeGreaterThan(3);
      expect(combinedBatch.join("\n")).toContain("Long split memory line.");
      expect(combinedBatch).toContain("# Log\nBeta memory line.");
    } finally {
      await manager.close?.();
    }
  });

  it("keeps custom batch runtimes per file without source-wide opt in", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
    await fs.writeFile(path.join(memoryDir, "2026-01-14.md"), "# Log\nGamma memory line.");
    const cfg = createCfg({
      provider: "batch-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(3);
      expect(providerRuntimeBatchCalls.every((call) => call.length === 1)).toBe(true);
      expect(providerRuntimeBatchCalls.map((call) => call[0] ?? "").toSorted()).toEqual(
        [
          "# Log\nAlpha memory line.\nZebra memory line.",
          "# Log\nBeta memory line.",
          "# Log\nGamma memory line.",
        ].toSorted(),
      );
    } finally {
      await manager.close?.();
    }
  });

  it("keeps custom batch runtimes concurrent without source-wide opt in", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
    await fs.writeFile(path.join(memoryDir, "2026-01-14.md"), "# Log\nGamma memory line.");
    const cfg = createCfg({
      provider: "batch-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    let releaseBatchGate: (() => void) | undefined;
    providerRuntimeBatchGate = new Promise((resolve) => {
      releaseBatchGate = resolve;
    });
    const syncPromise = manager.sync({ reason: "test" });
    let waitError: Error | undefined;
    try {
      await vi.waitFor(() => expect(providerRuntimeMaxActiveBatchCalls).toBeGreaterThan(1));
    } catch (err) {
      waitError = err instanceof Error ? err : new Error(String(err));
    } finally {
      releaseBatchGate?.();
      await syncPromise;
      await manager.close?.();
    }
    if (waitError) {
      throw waitError;
    }
  });

  it("bounds source-wide memory batches", async () => {
    const batchFileLimit = 2048;
    for (let index = 0; index < batchFileLimit; index += 1) {
      await fs.writeFile(
        path.join(memoryDir, `2026-02-${String(index + 1).padStart(4, "0")}.md`),
        `# Log\nBounded memory line ${index}.`,
      );
    }
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });

      expect(providerRuntimeBatchCalls).toHaveLength(2);
      expect(providerRuntimeBatchCalls[0]).toHaveLength(batchFileLimit);
      expect(providerRuntimeBatchCalls[1]).toHaveLength(1);
      expect(providerRuntimeBatchCalls.flat()).toHaveLength(batchFileLimit + 1);
    } finally {
      await manager.close?.();
    }
  });

  it("batches forced memory and session indexing across files", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
    await seedMemoryIndexSessionTranscript({
      sessionId: "session-alpha",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-07T15:25:04.113Z",
          content: "Session alpha memory line.",
        },
      ],
    });
    await seedMemoryIndexSessionTranscript({
      sessionId: "session-beta",
      messages: [
        {
          role: "assistant",
          timestamp: "2026-04-07T15:25:04.113Z",
          content: "Session beta memory line.",
        },
      ],
    });
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "cli", force: true });

      expect(providerRuntimeBatchCalls).toHaveLength(1);
      const combinedBatch = providerRuntimeBatchCalls[0] ?? [];
      expect(combinedBatch.slice(0, 2)).toEqual([
        "# Log\nAlpha memory line.\nZebra memory line.",
        "# Log\nBeta memory line.",
      ]);
      expect(combinedBatch.join("\n")).toContain("Session alpha memory line.");
      expect(combinedBatch.join("\n")).toContain("Session beta memory line.");
    } finally {
      await manager.close?.();
    }
  });

  it("does not full-reindex on search when existing metadata belongs to another provider", async () => {
    const oldCfg = createCfg({
      model: "old-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    const nextCfg = createCfg({
      provider: "gemini",
      model: "new-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const nextManager = await getFreshManager(nextCfg);
    try {
      expect(nextManager.status().dirty).toBe(true);
      expect(nextManager.status().custom?.indexIdentity).toEqual({
        status: "mismatched",
        reason: "index was built for model old-embed, expected new-embed",
      });
      embedBatchCalls = 0;

      const results = await nextManager.search("alpha");

      expect(results).toStrictEqual([]);
      expect(embedBatchCalls).toBe(0);
      expect(nextManager.status().dirty).toBe(true);

      await fs.writeFile(
        path.join(memoryDir, "2026-01-12.md"),
        "# Log\nAlpha memory line changed.\nZebra memory line.",
      );
      await nextManager.sync({ reason: "watch" });

      expect(embedBatchCalls).toBe(0);
      const stillPausedResults = await nextManager.search("alpha");
      expect(stillPausedResults).toStrictEqual([]);
      expect(nextManager.status().dirty).toBe(true);
      expect(nextManager.status().custom?.indexIdentity).toEqual({
        status: "mismatched",
        reason: "index was built for model old-embed, expected new-embed",
      });
    } finally {
      await nextManager.close?.();
    }
  });

  it.each([
    {
      direction: "HF to exact cache path",
      indexedModel: identityAliasFixture.canonicalModel,
      configuredModel: identityAliasFixture.cacheModel,
    },
    {
      direction: "exact cache path to HF",
      indexedModel: identityAliasFixture.cacheModel,
      configuredModel: identityAliasFixture.canonicalModel,
    },
  ])(
    "keeps $direction indexes and embedding caches usable",
    async ({ indexedModel, configuredModel }) => {
      const indexedCfg = createCfg({
        provider: identityAliasFixture.provider,
        model: identityAliasFixture.canonicalModel,
        cacheEnabled: true,
        vectorEnabled: false,
        onSearch: false,
        hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
      });
      const indexedManager = await getFreshManager(indexedCfg);
      await indexedManager.sync({ reason: "test", force: true });
      if (indexedModel !== identityAliasFixture.canonicalModel) {
        rewritePersistedProviderIdentity(indexedManager, indexedModel);
      }
      await indexedManager.close?.();

      const embedsBeforeReuse = embedBatchCalls;
      const nextCfg = createCfg({
        provider: identityAliasFixture.provider,
        model: configuredModel,
        cacheEnabled: true,
        vectorEnabled: false,
        onSearch: false,
        hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
      });
      const statusManager = await getFreshManager(nextCfg, "status");
      try {
        expect(statusManager.status().dirty).toBe(false);
        expect(statusManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      } finally {
        await statusManager.close?.();
      }

      const nextManager = await getFreshManager(nextCfg);
      try {
        const results = await nextManager.search("zebra");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.path).toContain("memory/2026-01-12.md");
        expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

        await nextManager.sync({ reason: "test", force: true });

        expect(embedBatchCalls).toBe(embedsBeforeReuse);
      } finally {
        await nextManager.close?.();
      }
    },
  );

  it("keeps status clean when configured provider alias resolves to indexed adapter", async () => {
    const oldCfg = createCfg({
      provider: "ollama",
      model: "ollama-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    const aliasCfg = createCfg({
      provider: "ollama-west",
      providerAliases: {
        "ollama-west": {
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          models: [],
        },
      },
      model: "ollama-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const statusManager = await getFreshManager(aliasCfg, "status");
    try {
      const status = statusManager.status();

      expect(status.dirty).toBe(false);
      expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await statusManager.close?.();
    }
  });

  it("keeps status clean when configured model defaults to the adapter model (#90413)", async () => {
    // Index under the provider's resolved default model, as provider init does.
    const indexCfg = createCfg({
      provider: "gemini",
      model: "gemini-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const indexManager = await getFreshManager(indexCfg);
    await indexManager.sync({ reason: "test", force: true });
    await indexManager.close?.();

    // Plain status path before provider init: settings.model is the empty
    // default, so identity must resolve the adapter model instead of comparing
    // meta against a blank "expected" model.
    const statusCfg = createCfg({
      provider: "gemini",
      model: "",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const statusManager = await getFreshManager(statusCfg, "status");
    try {
      const status = statusManager.status();

      expect(status.dirty).toBe(false);
      expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await statusManager.close?.();
    }
  });

  it("rebuilds missing metadata with existing chunks before search", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "# Log\nBeta memory line.");
    const oldManager = await getFreshManager(cfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();
    await fs.rm(path.join(memoryDir, "2026-01-12.md"));

    const nextManager = await getFreshManager(cfg);
    try {
      (
        nextManager as unknown as {
          db: { exec: (sql: string) => void };
        }
      ).db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);
      expect(nextManager.status().custom?.indexIdentity).toEqual({
        status: "missing",
        reason: "index metadata is missing",
      });

      const results = await nextManager.search("alpha");

      expect(nextManager.status().dirty).toBe(false);
      expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      expect(results.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(false);
      expect(results.some((result) => result.path.endsWith("memory/2026-01-13.md"))).toBe(true);
    } finally {
      await nextManager.close?.();
    }
  });

  it("does not search stale provider rows after embeddings become unavailable", async () => {
    const oldCfg = createCfg({
      model: "semantic-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    forceNoProvider = true;
    const nextManager = await getFreshManager(oldCfg);
    try {
      const results = await nextManager.search("alpha");

      expect(results).toStrictEqual([]);
      expect(nextManager.status().dirty).toBe(true);
      expect(nextManager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
      });
    } finally {
      await nextManager.close?.();
    }
  });

  it("does not rebuild missing semantic metadata when embeddings are unavailable", async () => {
    const oldCfg = createCfg({
      model: "semantic-embed",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    forceNoProvider = true;
    const nextManager = await getFreshManager(oldCfg);
    try {
      const db = (
        nextManager as unknown as {
          db: {
            exec: (sql: string) => void;
            prepare: (sql: string) => {
              get: () => { model?: string } | undefined;
            };
          };
        }
      ).db;
      db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);

      await nextManager.sync({ reason: "test" });

      expect(nextManager.status().dirty).toBe(true);
      expect(nextManager.status().custom?.indexIdentity).toEqual({
        status: "missing",
        reason: "index metadata is missing",
      });
      const row = db.prepare("SELECT model FROM memory_index_chunks LIMIT 1").get();
      expect(row?.model).toBe("semantic-embed");
    } finally {
      await nextManager.close?.();
    }
  });

  it("clears dirty after sessions-only identity reindex", async () => {
    try {
      setMemoryIndexStateDir(path.join(workspaceDir, ".state-sessions-only-reindex"));
      await seedMemoryIndexSessionTranscript({
        sessionId: "session-identity",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-07T15:25:04.113Z",
            content: "Session-only identity marker.",
          },
        ],
      });

      const oldCfg = createCfg({
        sources: ["sessions"],
        sessionMemory: true,
        model: "old-embed",
      });
      const oldManager = await getFreshManager(oldCfg);
      await oldManager.sync({ reason: "test", force: true });
      await oldManager.close?.();

      const nextCfg = createCfg({
        sources: ["sessions"],
        sessionMemory: true,
        provider: "gemini",
        model: "new-embed",
      });
      const nextManager = await getFreshManager(nextCfg);
      try {
        expect(nextManager.status().dirty).toBe(true);

        await nextManager.sync({ reason: "test", force: true });

        expect(nextManager.status().dirty).toBe(false);
        expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      } finally {
        await nextManager.close?.();
      }
    } finally {
      restoreMemoryIndexStateDir();
    }
  });

  it("marks sessions-only indexes dirty when metadata is missing but chunks exist", async () => {
    try {
      setMemoryIndexStateDir(path.join(workspaceDir, ".state-sessions-missing-meta"));
      await seedMemoryIndexSessionTranscript({
        sessionId: "session-missing-meta",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-07T15:25:04.113Z",
            content: "Sessions missing metadata marker.",
          },
        ],
      });

      const cfg = createCfg({
        sources: ["sessions"],
        sessionMemory: true,
      });
      const oldManager = await getFreshManager(cfg);
      await oldManager.sync({ reason: "test", force: true });
      await oldManager.close?.();

      const nextManager = await getFreshManager(cfg);
      try {
        (
          nextManager as unknown as {
            db: { exec: (sql: string) => void };
          }
        ).db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);

        const status = nextManager.status();

        expect(status.dirty).toBe(true);
        expect(status.custom?.indexIdentity).toEqual({
          status: "missing",
          reason: "index metadata is missing",
        });
      } finally {
        await nextManager.close?.();
      }
    } finally {
      restoreMemoryIndexStateDir();
    }
  });

  it("keeps provider cutover vector search paused during targeted session sync", async () => {
    try {
      setMemoryIndexStateDir(path.join(workspaceDir, ".state-targeted-cutover"));
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = path.join(sessionsDir, "session-targeted-cutover.jsonl");
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: "session",
            id: "session-targeted-cutover",
            timestamp: "2026-04-07T15:24:04.113Z",
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: "2026-04-07T15:25:04.113Z",
              content: [{ type: "text", text: "Targeted cutover marker." }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const oldCfg = createCfg({
        sources: ["memory", "sessions"],
        sessionMemory: true,
        model: "old-embed",
      });
      const oldManager = await getFreshManager(oldCfg);
      await oldManager.sync({ reason: "test", force: true });
      await oldManager.close?.();

      const nextCfg = createCfg({
        sources: ["memory", "sessions"],
        sessionMemory: true,
        provider: "gemini",
        model: "new-embed",
      });
      const nextManager = await getFreshManager(nextCfg);
      try {
        expect(nextManager.status().dirty).toBe(true);
        embedBatchCalls = 0;

        await nextManager.sync({ reason: "test", archiveFiles: [sessionFile] });

        expect(embedBatchCalls).toBe(0);
        expect(nextManager.status().dirty).toBe(true);
        expect(nextManager.status().custom?.indexIdentity).toEqual({
          status: "mismatched",
          reason: "index was built for model old-embed, expected new-embed",
        });
        const results = await nextManager.search("alpha");
        expect(results).toStrictEqual([]);
      } finally {
        await nextManager.close?.();
      }
    } finally {
      restoreMemoryIndexStateDir();
    }
  });

  it("preserves memory dirty events raised during session identity reindex", async () => {
    try {
      setMemoryIndexStateDir(path.join(workspaceDir, ".state-dirty-during-session"));
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "session-dirty-during-reindex.jsonl"),
        [
          JSON.stringify({
            type: "session",
            id: "session-dirty-during-reindex",
            timestamp: "2026-04-07T15:24:04.113Z",
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: "2026-04-07T15:25:04.113Z",
              content: [{ type: "text", text: "Dirty during session marker." }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const oldCfg = createCfg({
        sources: ["memory", "sessions"],
        sessionMemory: true,
        model: "old-embed",
      });
      const oldManager = await getFreshManager(oldCfg);
      await oldManager.sync({ reason: "test", force: true });
      await oldManager.close?.();

      const nextCfg = createCfg({
        sources: ["memory", "sessions"],
        sessionMemory: true,
        provider: "gemini",
        model: "new-embed",
      });
      const nextManager = await getFreshManager(nextCfg);
      try {
        const fields = nextManager as unknown as {
          dirty: boolean;
          syncArchiveFiles: (params: unknown) => Promise<void>;
        };
        const syncArchiveFiles = fields.syncArchiveFiles.bind(nextManager);
        fields.syncArchiveFiles = async (params) => {
          fields.dirty = true;
          await syncArchiveFiles(params);
        };

        await nextManager.sync({ reason: "test", force: true });

        expect(nextManager.status().dirty).toBe(true);
        expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      } finally {
        await nextManager.close?.();
      }
    } finally {
      restoreMemoryIndexStateDir();
    }
  });

  it("closes embedding providers when memory index managers close", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);

    await manager.probeEmbeddingAvailability();
    expect(providerCloseCalls).toBe(0);

    await manager.close();
    await manager.close();

    expect(providerCloseCalls).toBe(1);
  });

  it("waits for pending sync before closing embedding providers", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    await manager.probeEmbeddingAvailability();
    let resolveSync: () => void = () => {};
    (manager as unknown as { syncing: Promise<void> }).syncing = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });

    const closePromise = manager.close();
    try {
      await Promise.resolve();
      expect(providerCloseCalls).toBe(0);

      let closeSettled = false;
      void closePromise.then(() => {
        closeSettled = true;
      });
      await Promise.resolve();

      expect(closeSettled).toBe(false);
    } finally {
      resolveSync();
    }
    await closePromise;
    expect(providerCloseCalls).toBe(1);
  });

  it("waits for sync that attaches after provider initialization before closing providers", async () => {
    let releaseProviderInit: () => void = () => {};
    providerInitGate = new Promise<void>((resolve) => {
      releaseProviderInit = resolve;
    });
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    let releaseSync: () => void = () => {};
    const syncStarted = new Promise<void>((resolve) => {
      const originalRunSyncWithReadonlyRecovery = (
        manager as unknown as {
          runSyncWithReadonlyRecovery: (params?: {
            reason?: string;
            force?: boolean;
            archiveFiles?: string[];
            progress?: (update: unknown) => void;
          }) => Promise<void>;
        }
      ).runSyncWithReadonlyRecovery.bind(manager);
      (
        manager as unknown as {
          runSyncWithReadonlyRecovery: typeof originalRunSyncWithReadonlyRecovery;
        }
      ).runSyncWithReadonlyRecovery = async (params) => {
        resolve();
        await new Promise<void>((syncResolve) => {
          releaseSync = syncResolve;
        });
        await originalRunSyncWithReadonlyRecovery(params);
      };
    });

    const syncPromise = manager.sync({ reason: "test" });
    await vi.waitFor(() => {
      expect(providerCalls).toHaveLength(1);
    });

    const closePromise = manager.close();
    try {
      releaseProviderInit();
      await syncStarted;
      await Promise.resolve();

      expect(providerCloseCalls).toBe(0);
    } finally {
      releaseSync();
    }
    await syncPromise;
    await closePromise;
    expect(providerCloseCalls).toBe(1);
  });

  it("evicts scoped memory index managers before close settles", async () => {
    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    const closePromise = closeMemoryIndexManagersForAgent({ cfg, agentId: "main" });
    let second: MemoryIndexManager | null;
    try {
      await vi.waitFor(() => {
        expect(providerCloseCalls).toBe(1);
      });

      second = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
      managersForCleanup.add(second);
      expect(second).not.toBe(first);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }
    await closePromise;

    const third = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    managersForCleanup.add(third);
    expect(third).toBe(second);
  });

  it("does not reuse memory index managers across local-service hosts", async () => {
    const cfg = createCfg({});
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);
    const first = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: firstAcquire,
      }),
    );
    managersForCleanup.add(first);

    const second = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: secondAcquire,
      }),
    );
    managersForCleanup.add(second);
    const secondAgain = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: secondAcquire,
      }),
    );

    expect(Object.is(second, first)).toBe(false);
    expect(Object.is(secondAgain, second)).toBe(true);
  });

  it("retries embedding provider close before releasing the manager", async () => {
    providerCloseFailuresRemaining = 1;
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);

    await manager.probeEmbeddingAvailability();
    await manager.close();

    expect(providerCloseCalls).toBe(2);
  });

  it("indexes multimodal image and audio files from extra paths with Gemini structured inputs", async () => {
    const mediaDir = path.join(workspaceDir, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));

    const cfg = createCfg({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);
  });

  it("finds keyword matches via hybrid search when query embedding is zero", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      }),
    );
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

  it("preserves keyword-only hybrid hits when minScore exceeds text weight", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        minScore: 0.35,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      }),
    );
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

  it("reports vector availability after probe", async () => {
    const cfg = createCfg({ vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.storeAvailable).toBe(available);
    expect(status.vector?.semanticAvailable).toBe(available);
    expect(status.vector?.available).toBe(available);
  });

  it("rebuilds vector tables created before completeness markers", async () => {
    const cfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const legacyManager = await getFreshManager(cfg);
    const available = await legacyManager.probeVectorStoreAvailability?.();
    if (!available) {
      await legacyManager.close?.();
      return;
    }
    const legacyDb = Reflect.get(legacyManager, "db") as DatabaseSync;
    legacyDb.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      );
      INSERT INTO memory_index_chunks_vec VALUES ('orphan-before-marker', '[1,0,0]');
    `);
    await legacyManager.close?.();

    const manager = await getFreshManager(cfg);
    try {
      await expect(manager.probeVectorStoreAvailability?.()).resolves.toBe(false);
      expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
    } finally {
      await manager.close?.();
    }
  });

  it("drops the shipped legacy vector table and schedules a full reindex", async () => {
    const cfg = createCfg({ vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const db = Reflect.get(manager, "db") as DatabaseSync;
    db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");

    const available = await manager.probeVectorStoreAvailability?.();
    if (!available) {
      return;
    }

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
        .get(),
    ).toBeUndefined();
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });

  it("probes sqlite vector store availability without initializing embeddings", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      vectorEnabled: true,
    });
    const manager = await getPersistentManager(cfg);

    const available = await manager.probeVectorStoreAvailability?.();
    const status = manager.status();

    expect(providerCalls).toStrictEqual([]);
    expect(typeof status.vector?.storeAvailable).toBe("boolean");
    expect(status.vector?.storeAvailable).toBe(available);
    expect(status.vector?.semanticAvailable).toBeUndefined();
    expect(status.vector?.available).toBeUndefined();
  });

  it("keeps current vector indexes clean after vector store probing", async () => {
    const cfg = createCfg({ provider: "gemini" });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test", force: true });
      const metaAccess = manager as unknown as {
        readMeta(): MemoryIndexMeta | null;
      };
      const meta = metaAccess.readMeta();
      if (!meta) {
        throw new Error("expected index metadata");
      }
      expect(meta.vectorDims).toBe(4);

      await manager.probeVectorStoreAvailability?.();
      const status = manager.status();

      expect(status.dirty).toBe(false);
    } finally {
      await manager.close?.();
    }
  });

  it("forces a rebuild after incremental writes while vectors are disabled", async () => {
    const enabledCfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const initialManager = await getFreshManager(enabledCfg);
    await initialManager.sync({ reason: "test", force: true });
    await initialManager.close?.();

    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Updated\n\nvector writes were disabled for this update\n",
    );
    const disabledManager = await getFreshManager(
      createCfg({ provider: "gemini", vectorEnabled: false }),
    );
    Reflect.set(disabledManager, "dirty", true);
    await disabledManager.sync({ reason: "test" });
    const disabledDb = Reflect.get(disabledManager, "db") as DatabaseSync;
    expect(
      disabledDb
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
    await disabledManager.close?.();

    const reloadedManager = await getFreshManager(enabledCfg);
    try {
      await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(false);
      expect(Reflect.get(reloadedManager, "memoryFullRetryDirty")).toBe(true);
      expect(reloadedManager.status().dirty).toBe(true);

      await reloadedManager.sync({ reason: "test" });
      const rebuiltDb = Reflect.get(reloadedManager, "db") as DatabaseSync;
      expect(
        rebuiltDb
          .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
          .get(),
      ).toEqual({ value: "clean" });
      await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(true);
    } finally {
      await reloadedManager.close?.();
    }
  });

  it("keeps empty vector indexes clean after vector store probing", async () => {
    await fs.rm(path.join(memoryDir, "2026-01-12.md"));
    const legacyCfg = createCfg({
      provider: "gemini",
      vectorEnabled: false,
    });
    const legacyManager = await getFreshManager(legacyCfg);
    await legacyManager.sync({ reason: "test", force: true });
    await legacyManager.close?.();

    const cfg = createCfg({
      provider: "gemini",
      vectorEnabled: true,
    });
    const manager = await getFreshManager(cfg, "status");
    try {
      await manager.probeVectorStoreAvailability?.();

      const status = manager.status();

      expect(status.dirty).toBe(false);
      expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await manager.close?.();
    }
  });

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

  it("keeps metadata after unchanged in-place force reindex", async () => {
    const cfg = createCfg({});
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test", force: true });
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });

      await manager.sync({ reason: "cli", force: true });

      expect(manager.status().dirty).toBe(false);
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      await manager.close?.();
    }
  });

  it("reuses embedding cache entries during in-place reindex", async () => {
    const cfg = createCfg({
      cacheEnabled: true,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const beforeCalls = embedBatchCalls;
    (manager as unknown as { dirty: boolean }).dirty = true;
    await manager.sync({ reason: "test", force: true });

    expect(embedBatchCalls).toBe(beforeCalls);
  });

  it("builds FTS index and returns search results when no embedding provider is available", async () => {
    forceNoProvider = true;

    const cfg = createCfg({
      provider: "none",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(embedBatchCalls).toBe(0);

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/Alpha/i);

    const noResults = await manager.search("nonexistent_xyz_keyword");
    expect(noResults.length).toBe(0);
  });

  it("ranks an exact path stem ahead of a body match before applying the result limit", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(path.join(memoryDir, "project-lantern.md"), "Unrelated exact-path body.");
    await fs.writeFile(
      path.join(memoryDir, "body-match.md"),
      "Project lantern project lantern project lantern.",
    );
    await manager.sync({ reason: "test" });

    const results = await manager.search("project-lantern", { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/project-lantern.md");
    expect(results[0]?.score).toBe(1);
  });

  it("does not let fallback-term filenames consume the candidate cap", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    for (let index = 0; index < 5; index += 1) {
      const duplicateDir = path.join(memoryDir, `alpha-${index}`);
      await fs.mkdir(duplicateDir, { recursive: true });
      await fs.writeFile(path.join(duplicateDir, "alpha.md"), "Unrelated path-only candidate.");
    }
    await fs.writeFile(
      path.join(memoryDir, "body-match.md"),
      "Alpha alpha alpha alpha alpha strongest fallback body match.",
    );
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha gamma", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/body-match.md");
  });

  it("preserves fallback body boosts through hybrid weighting", async () => {
    const cfg = createCfg({
      minScore: 0,
      hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
    });
    const manager = await getPersistentManager(cfg);
    type HybridKeywordHit = {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
      source: "memory";
      textScore: number;
      pathScore: number;
      exactPathSpecificity: 0;
    };
    const internal = manager as unknown as {
      mergeHybridResults: (params: {
        query: string;
        vector: [];
        keyword: HybridKeywordHit[];
        vectorWeight: number;
        textWeight: number;
      }) => Promise<Array<{ path: string; score: number; textScore: number }>>;
    };

    const results = await internal.mergeHybridResults({
      query: "alpha gamma",
      vector: [],
      keyword: [
        {
          id: "body",
          path: "memory/body.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "body",
          source: "memory",
          textScore: 0.1,
          pathScore: 0,
          exactPathSpecificity: 0,
        },
        {
          id: "path",
          path: "memory/alpha.md",
          startLine: 1,
          endLine: 2,
          score: 0.5,
          snippet: "path",
          source: "memory",
          textScore: 0,
          pathScore: 0.5,
          exactPathSpecificity: 0,
        },
      ],
      vectorWeight: 0,
      textWeight: 1,
    });

    expect(results.map((entry) => entry.path)).toEqual(["memory/body.md", "memory/alpha.md"]);
    expect(results[0]).toMatchObject({ score: 0.9, textScore: 0.1 });
  });

  it("bounds the merged six-term fallback candidate set", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      minScore: 0,
      hybrid: { enabled: true },
    });
    const manager = await getPersistentManager(cfg);
    const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const term of terms) {
      for (let index = 0; index < 5; index += 1) {
        await fs.writeFile(path.join(memoryDir, `${term}-${index}.md`), `${term} body ${index}`);
      }
    }
    await manager.sync({ reason: "test" });

    const internal = manager as unknown as {
      searchKeywordWithFallback: (
        query: string,
        limit: number,
        options: { boostFallbackRanking?: boolean },
        sources: Array<"memory">,
      ) => Promise<Array<{ exactPathSpecificity: number }>>;
    };
    const candidates = await internal.searchKeywordWithFallback(
      terms.join(" "),
      4,
      { boostFallbackRanking: true },
      ["memory"],
    );

    expect(candidates).toHaveLength(4);
    expect(candidates.every((entry) => entry.exactPathSpecificity === 0)).toBe(true);
  });

  it("counts exact candidate headroom by distinct path instead of chunk", async () => {
    const manager = await getPersistentManager(createCfg({ hybrid: { enabled: true } }));
    type TestKeywordHit = {
      id: string;
      path: string;
      source: "memory";
      startLine: number;
      endLine: number;
      score: number;
      textScore: number;
      pathScore: number;
      exactPathSpecificity: 2;
      snippet: string;
    };
    const sharedPath = "memory/000/foo.md";
    const bodyHits: TestKeywordHit[] = Array.from({ length: 4 }, (_, index) => ({
      id: `body-${index}`,
      path: sharedPath,
      source: "memory",
      startLine: index + 2,
      endLine: index + 2,
      score: 1 - index / 100,
      textScore: 1 - index / 100,
      pathScore: 0,
      exactPathSpecificity: 2,
      snippet: `body ${index}`,
    }));
    const pathHits: TestKeywordHit[] = Array.from({ length: 200 }, (_, index) => ({
      id: `path-${index}`,
      path: `memory/${index.toString().padStart(3, "0")}/foo.md`,
      source: "memory",
      startLine: 1,
      endLine: 1,
      score: 1,
      textScore: 0,
      pathScore: 0,
      exactPathSpecificity: 2,
      snippet: `path ${index}`,
    }));
    const internal = manager as unknown as {
      limitKeywordSearchHits: (hits: TestKeywordHit[], nonExactLimit: number) => TestKeywordHit[];
    };

    const limited = internal.limitKeywordSearchHits(bodyHits.concat(pathHits), 4);
    const paths = new Set(limited.map((entry) => entry.path));

    expect(limited).toHaveLength(204);
    expect(paths.size).toBe(200);
    expect(paths.has("memory/199/foo.md")).toBe(true);
  });

  it("uses body relevance within the same exact basename tier in FTS-only mode", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    const weakDir = path.join(memoryDir, "a");
    const strongDir = path.join(memoryDir, "z");
    await fs.mkdir(weakDir, { recursive: true });
    await fs.mkdir(strongDir, { recursive: true });
    await fs.writeFile(path.join(weakDir, "foo.md"), "Unrelated weak body.");
    await fs.writeFile(path.join(strongDir, "foo.md"), "foo md foo md foo md strong body");
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/z/foo.md");
    expect(results[0]?.score).toBe(1);
  });

  it("returns exact basename candidates with fixed FTS ranking", async () => {
    forceNoProvider = true;
    const staleDir = path.join(fixtureRoot, "decay-a-stale");
    const freshDir = path.join(fixtureRoot, "decay-z-fresh");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    const staleFooPath = path.join(staleDir, "foo.md");
    const freshFooPath = path.join(freshDir, "foo.md");
    const staleBarPath = path.join(staleDir, "bar.md");
    await fs.writeFile(staleFooPath, "Unrelated stale candidate.");
    await fs.writeFile(freshFooPath, "Unrelated fresh candidate.");
    await fs.writeFile(staleBarPath, "bar md bar md bar md strongest stale body");
    await fs.writeFile(path.join(freshDir, "bar.md"), "bar md fresh body");
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    await Promise.all([
      fs.utimes(staleFooPath, staleMtime, staleMtime),
      fs.utimes(staleBarPath, staleMtime, staleMtime),
    ]);
    const cfg = createCfg({
      provider: "none",
      extraPaths: [staleDir, freshDir],
      minScore: 0,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }
    await manager.sync({ reason: "test" });

    for (const basename of ["foo.md", "bar.md"]) {
      const results = await manager.search(basename, { maxResults: 1, minScore: 0 });
      expect(results).toHaveLength(1);
      expect(results[0]?.score).toBe(1);
    }
  });

  it("applies the fixed FTS candidate cap to exact paths", async () => {
    forceNoProvider = true;
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixtureRoot, `decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "foo.md");
      await fs.mkdir(extraDir, { recursive: true });
      const body = index < 4 ? "foo md stale content candidate." : "Unrelated fresh candidate.";
      await fs.writeFile(filePath, body);
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      provider: "none",
      extraPaths,
      minScore: 0,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("applies the fixed hybrid candidate cap", async () => {
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixtureRoot, `hybrid-decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "alpha.md");
      await fs.mkdir(extraDir, { recursive: true });
      const body = index === 4 ? "Alpha beta lower-similarity candidate." : "Alpha candidate.";
      await fs.writeFile(filePath, body);
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      extraPaths,
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    const results = await manager.search("alpha.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("keeps fixed hybrid ranking when search degrades to keyword-only", async () => {
    const staleMtime = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const extraPaths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = index === 4 ? "z-fresh" : `a-stale-${index}`;
      const extraDir = path.join(fixtureRoot, `degraded-decay-cap-${suffix}`);
      const filePath = path.join(extraDir, "beta.md");
      await fs.mkdir(extraDir, { recursive: true });
      await fs.writeFile(filePath, "Beta equal content candidate.");
      if (index < 4) {
        await fs.utimes(filePath, staleMtime, staleMtime);
      }
      extraPaths.push(extraDir);
    }
    const cfg = createCfg({
      extraPaths,
      fallback: "none",
      minScore: 0,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const degraded = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embedQuery: () => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      } | null;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
    };
    const provider = degraded.provider;
    if (!provider) {
      throw new Error("Expected a test embedding provider");
    }
    provider.embedQuery = async () => {
      throw createLocalWorkerExitError();
    };
    degraded.markLocalEmbeddingProviderDegraded = () => {
      degraded.provider = null;
    };

    const results = await manager.search("beta.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("keeps body relevance for an exact basename beyond the exact candidate cap", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    const duplicatesDir = path.join(memoryDir, "readme-dupes");
    for (let index = 0; index < 205; index += 1) {
      const duplicateDir = path.join(duplicatesDir, `a-${index.toString().padStart(3, "0")}`);
      await fs.mkdir(duplicateDir, { recursive: true });
      await fs.writeFile(path.join(duplicateDir, "README.md"), "Unrelated weak body.");
    }
    const strongDir = path.join(duplicatesDir, "z-strong");
    await fs.mkdir(strongDir, { recursive: true });
    await fs.writeFile(
      path.join(strongDir, "README.md"),
      "README md README md README md strongest body match.",
    );
    await fs.writeFile(
      path.join(memoryDir, "readme-body-only.md"),
      "README md body-only candidate.",
    );
    await fs.writeFile(path.join(memoryDir, "README.md.notes"), "Unrelated partial path.");
    await manager.sync({ reason: "test" });

    const results = await manager.search("README.md", { maxResults: 1, minScore: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/readme-dupes/z-strong/README.md");
    expect(results[0]?.score).toBe(1);

    const internal = manager as unknown as {
      searchKeyword: (
        query: string,
        limit: number,
        options: { boostFallbackRanking?: boolean },
        sources: Array<"memory">,
      ) => Promise<Array<{ exactPathSpecificity: number; path: string; source: string }>>;
    };
    const candidates = await internal.searchKeyword(
      "README.md",
      4,
      { boostFallbackRanking: true },
      ["memory"],
    );
    const exactCandidates = candidates.filter((entry) => entry.exactPathSpecificity > 0);
    const exactPathCount = new Set(exactCandidates.map((entry) => `${entry.source}:${entry.path}`))
      .size;
    const nonExactCount = candidates.length - exactCandidates.length;
    expect(exactPathCount).toBe(200);
    expect(exactCandidates.length).toBeLessThanOrEqual(204);
    expect(nonExactCount).toBeGreaterThan(0);
    expect(nonExactCount).toBeLessThanOrEqual(4);
    expect(candidates.length).toBeLessThanOrEqual(208);
  });

  it("keeps boosted score ordering for non-exact FTS-only body matches", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(memoryDir, "project-memory-notes.md"),
      "Project memory notes covering workspace context and retrieval behavior.",
    );
    await fs.writeFile(path.join(memoryDir, "notes.md"), "Project memory context.");
    await manager.sync({ reason: "test" });

    const results = await manager.search("project memory context", {
      maxResults: 1,
      minScore: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/project-memory-notes.md");
    expect(results[0]?.score).toBeLessThanOrEqual(1);
  });

  it("keeps an exact dated path ahead in FTS-only mode", async () => {
    forceNoProvider = true;
    const cfg = createCfg({
      provider: "none",
      minScore: 0.35,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(path.join(memoryDir, "2020-01-01.md"), "Unrelated exact-path body.");
    await fs.writeFile(path.join(memoryDir, "body-match.md"), "2020 01 01 2020 01 01 2020 01 01");
    await manager.sync({ reason: "test" });

    const results = await manager.search("2020-01-01", { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("memory/2020-01-01.md");
    expect(results[0]?.score).toBe(1);
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
  it("prefers exact session transcript hits in FTS-only mode", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-ranking",
      });
      if (!manager) {
        return;
      }

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(memoryPath, "Project Nebula stale codename: ORBIT-9.\n", "utf8");
      const staleAt = new Date("2020-01-01T00:00:00.000Z");
      await fs.utimes(memoryPath, staleAt, staleAt);

      const now = Date.parse("2026-04-07T15:25:04.113Z");
      await seedMemoryIndexSessionTranscript({
        sessionId: "session-ranking",
        messages: [
          {
            role: "user",
            timestamp: new Date(now - 30_000).toISOString(),
            content: "What is the current Project Nebula codename?",
          },
          {
            role: "assistant",
            timestamp: new Date(now).toISOString(),
            content: "The current Project Nebula codename is ORBIT-10.",
          },
        ],
      });

      await manager.sync({ reason: "test", force: true });
      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      restoreMemoryIndexStateDir();
    }
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
      restoreMemoryIndexStateDir();
    }
  });
  it("keeps remember-only session transcripts out of ordinary manager searches", async () => {
    forceNoProvider = true;
    setMemoryIndexStateDir(path.join(workspaceDir, ".state-remember-search-sources"));
    try {
      const cfg = createCfg({
        provider: "none",
        rememberAcrossConversations: true,
        minScore: 0,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      });
      const manager = await getFreshManager(cfg);
      managersForCleanup.add(manager);
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
      restoreMemoryIndexStateDir();
    }
  });

  it("status-purpose manager detects unindexed session transcripts as dirty", async () => {
    // Regression test for #97814: plain openclaw memory status (purpose: status)
    // must report dirty=true when session files exist without index rows.
    const cfg = createCfg({ sources: ["sessions"], sessionMemory: true });
    const stateDirName = ".state-status-dirty-test";
    setMemoryIndexStateDir(path.join(workspaceDir, stateDirName));
    try {
      await seedMemoryIndexSessionTranscript({
        sessionId: "status-dirty-test",
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: "Unindexed session transcript.",
          },
        ],
      });

      const manager = await getFreshManager(cfg, "status");
      managersForCleanup.add(manager);

      const result = manager.status();
      expect(result.dirty).toBe(true);
    } finally {
      restoreMemoryIndexStateDir();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
