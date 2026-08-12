// Memory Core tests cover manager keyword retrieval behavior.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
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

  async function seedMemoryIndexSessionTranscript(params: {
    messages: Array<{
      content: string;
      role: "assistant" | "user";
      senderIsOwner?: boolean;
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
          ...(message.senderIsOwner ? { __openclaw: { senderIsOwner: true } } : {}),
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

  it("bounds the merged six-term fallback candidate set", async () => {
    forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, hybrid: { enabled: true } }),
    );
    const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const term of terms) {
      for (let index = 0; index < 5; index += 1) {
        await fs.writeFile(path.join(memoryDir, `${term}-${index}.md`), `${term} body ${index}`);
      }
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search(terms.join(" "), { maxResults: 4, minScore: 0 });

    expect(results).toHaveLength(4);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(4);
  });

  it("counts exact candidate headroom by distinct path instead of chunk", async () => {
    forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, hybrid: { enabled: true } }),
    );
    for (let index = 0; index < 200; index += 1) {
      const dir = path.join(memoryDir, index.toString().padStart(3, "0"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "foo.md"), `foo body ${index}`);
    }
    await manager.sync({ reason: "test" });

    const results = await manager.search("foo.md", { maxResults: 204, minScore: 0 });

    expect(results).toHaveLength(200);
    expect(new Set(results.map((entry) => entry.path)).size).toBe(200);
    expect(results.some((entry) => entry.path === "memory/199/foo.md")).toBe(true);
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
      expect(results[0]?.provenance).toMatchObject({
        originClass: "untrusted",
        sessionKind: "interactive",
      });
    } finally {
      restoreMemoryIndexStateDir();
    }
  });
});
