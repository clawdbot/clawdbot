// Memory Core tests cover index plugin behavior.
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  hashText,
  INVALID_PROJECT_ANNOTATION_KEY,
  MEMORY_CHUNKING_VERSION,
  type MemorySessionSyncTarget,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import "./test-runtime-mocks.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
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

  async function getFreshManager(
    cfg: TestCfg,
    purpose?: "default" | "status" | "cli",
  ): Promise<MemoryIndexManager> {
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main", purpose }));
    managersForCleanup.add(manager);
    return manager;
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
      expect(results[0]?.provenance).toMatchObject({
        originClass: "agent",
        sessionKind: "unknown",
      });
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

  it("indexes trailing recall annotations only from curated memory files", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# Curated entries",
        "",
        "- Alpha deploy preference. <!-- trigger: alpha deploy --> <!-- importance: 4 --> <!-- project: alpha-key -->",
        "  Keep the alpha gateway local.",
        "- Beta deploy preference. <!-- trigger: beta deploy --> <!-- importance: 9 --> <!-- project: beta-key -->",
        "- Global deploy preference. <!-- trigger: global defaults --> <!-- importance: 7 -->",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(workspaceDir, "USER.md"),
      "- Prefer concise replies. <!-- trigger: writing style --> <!-- importance: 7 -->\n",
    );
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "- Daily note. <!-- trigger: should not inject --> <!-- importance: 10 --> <!-- project: github.com/openclaw/openclaw -->\n",
    );
    await fs.writeFile(
      path.join(memoryDir, "2026-01-13.md"),
      [
        "- Uppercase path. <!-- project: path:/Users/Alice/Repo -->",
        "- Lowercase path. <!-- project: path:/Users/alice/repo -->",
      ].join("\n"),
    );

    const manager = await getFreshManager(createCfg({}));
    try {
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const rows = db
        .prepare(
          `SELECT chunk.path, chunk.start_line AS startLine, chunk.text, metadata.importance,
                  metadata.triggers, metadata.project_key AS projectKey,
                  provenance.origin_class AS originClass
           FROM memory_index_chunks AS chunk
           LEFT JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           JOIN memory_index_chunk_provenance AS provenance
             ON provenance.chunk_id = chunk.id
           WHERE chunk.source = 'memory'
           ORDER BY chunk.path, chunk.start_line`,
        )
        .all() as Array<{
        path: string;
        startLine: number;
        text: string;
        importance: number | null;
        triggers: string | null;
        projectKey: string | null;
        originClass: string;
      }>;

      const memoryEntries = rows.filter((row) => row.path === "MEMORY.md" && row.triggers !== null);
      expect(memoryEntries).toHaveLength(3);
      expect(memoryEntries).toMatchObject([
        {
          text: "- Alpha deploy preference.\n  Keep the alpha gateway local.",
          importance: 4,
          triggers: "alpha deploy",
          projectKey: "alpha-key",
          originClass: "agent",
        },
        {
          text: "- Beta deploy preference.",
          importance: 9,
          triggers: "beta deploy",
          projectKey: "beta-key",
          originClass: "agent",
        },
        {
          text: "- Global deploy preference.",
          importance: 7,
          triggers: "global defaults",
          projectKey: null,
          originClass: "agent",
        },
      ]);
      expect(rows.find((row) => row.path === "USER.md")).toMatchObject({
        importance: 7,
        triggers: "writing style",
        projectKey: null,
        originClass: "agent",
      });
      expect(rows.find((row) => row.path === "memory/2026-01-12.md")).toMatchObject({
        importance: null,
        triggers: null,
        projectKey: "github.com/openclaw/openclaw",
        originClass: "agent",
      });
      expect(rows.find((row) => row.path === "memory/2026-01-13.md")).toMatchObject({
        importance: null,
        triggers: null,
        projectKey: "path:/Users/Alice/Repo; path:/Users/alice/repo",
        originClass: "agent",
      });
      expect(rows.every((row) => !row.text.includes("<!--"))).toBe(true);
      expect(embeddedBatchTexts.length).toBeGreaterThan(0);
      expect(embeddedBatchTexts.every((text) => !text.includes("<!--"))).toBe(true);

      for (const query of ["trigger", "importance", "project"]) {
        const annotationHits = await manager.search(query, {
          lexicalOnly: true,
          maxResults: 20,
          minScore: 0,
          sources: ["memory"],
        });
        expect(annotationHits).toEqual([]);
      }

      const bodyHits = await manager.search("Alpha deploy preference", {
        lexicalOnly: true,
        maxResults: 10,
        minScore: 0,
        sources: ["memory"],
      });
      expect(bodyHits[0]?.snippet).toContain("Alpha deploy preference.");
      expect(bodyHits[0]?.snippet).not.toContain("<!--");
    } finally {
      await manager.close?.();
    }
  });

  it("round-trips mixed-case project keys through indexed recall consumers", async () => {
    const projectKey = "github.com/OpenClaw/OpenClaw";
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      `- Follow the kraken deploy ritual. <!-- trigger: kraken deploy ritual --> <!-- importance: 8 --> <!-- project: ${projectKey} -->\n`,
    );

    const manager = await getFreshManager(createCfg({}));
    try {
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      expect(
        db
          .prepare(
            `SELECT metadata.project_key AS projectKey
             FROM memory_index_chunks AS chunk
             JOIN memory_index_chunk_recall_metadata AS metadata
               ON metadata.chunk_id = chunk.id
             WHERE chunk.path = 'MEMORY.md'
               AND metadata.triggers = 'kraken deploy ritual'`,
          )
          .get(),
      ).toEqual({ projectKey });

      if (!manager.listCuratedProjectCandidates || !manager.listTriggerCandidates) {
        throw new Error("expected curated project and trigger candidate listing");
      }
      const activeProjectKeys = [projectKey];
      const curated = await manager.listCuratedProjectCandidates({ activeProjectKeys });
      const triggers = await manager.listTriggerCandidates({ activeProjectKeys });
      expect(curated).toMatchObject([{ projectKey, triggers: "kraken deploy ritual" }]);
      expect(triggers).toMatchObject([{ projectKey, triggers: "kraken deploy ritual" }]);

      const neutral = await manager.search("kraken deploy", {
        minScore: 0,
        maxResults: 10,
        activeProjectKeys: [],
      });
      const active = await manager.search("kraken deploy", {
        minScore: 0,
        maxResults: 10,
        activeProjectKeys,
      });
      const neutralHit = neutral.find((entry) => entry.projectKey === projectKey);
      const activeHit = active.find((entry) => entry.projectKey === projectKey);
      expect(neutralHit).toBeDefined();
      expect(activeHit).toBeDefined();
      if (!neutralHit || !activeHit) {
        throw new Error("expected mixed-case project hit in neutral and active search");
      }
      expect(activeHit.score).toBeGreaterThan(neutralHit.score);
    } finally {
      await manager.close?.();
    }
  });

  it("keeps invalid project annotations scoped but unsatisfiable", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "- Invalid fact. <!-- trigger: invalid fact --> <!-- project: bad< -->",
        "- Mixed fact. <!-- trigger: mixed fact --> <!-- project: alpha-key; bad< -->",
        "- Unterminated fact. <!-- trigger: unterminated fact --> <!-- project: alpha-key",
        "- Global fact. <!-- trigger: global fact -->",
      ].join("\n"),
    );
    const manager = await getFreshManager(createCfg({ provider: "none" }));
    try {
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      expect(
        db
          .prepare(
            `SELECT metadata.triggers, metadata.project_key AS projectKey
             FROM memory_index_chunks AS chunk
             LEFT JOIN memory_index_chunk_recall_metadata AS metadata
               ON metadata.chunk_id = chunk.id
             WHERE chunk.path = 'MEMORY.md'
             ORDER BY chunk.start_line`,
          )
          .all(),
      ).toEqual([
        { triggers: "invalid fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
        { triggers: "mixed fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
        { triggers: null, projectKey: INVALID_PROJECT_ANNOTATION_KEY },
        { triggers: "global fact", projectKey: null },
      ]);
      const activeProjectKeys = ["alpha-key"];
      if (!manager.listTriggerCandidates) {
        throw new Error("expected trigger candidate listing");
      }
      const triggerCandidates = await manager.listTriggerCandidates({ activeProjectKeys });
      expect(triggerCandidates).toMatchObject([{ triggers: "global fact" }]);
      const results = await manager.search("fact", {
        minScore: 0,
        maxResults: 10,
        activeProjectKeys,
      });
      expect(
        results.every((entry) => !/Invalid fact|Mixed fact|Unterminated fact/u.test(entry.snippet)),
      ).toBe(true);
    } finally {
      await manager.close?.();
    }
  });

  it("inherits entry-scoped annotations across oversized curated fragments", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "- Oversized alpha entry. <!-- trigger: oversized alpha --> <!-- importance: 8 --> <!-- project: alpha-key -->",
        `  ${"alpha-fragment-body ".repeat(400)}`,
        "- Global neighbor. <!-- trigger: global neighbor -->",
      ].join("\n"),
    );

    const manager = await getFreshManager(createCfg({ provider: "none" }));
    try {
      const settings = Reflect.get(manager, "settings") as {
        chunking: { tokens: number; overlap: number };
      };
      settings.chunking = { tokens: 64, overlap: 0 };
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const rows = db
        .prepare(
          `SELECT chunk.text, metadata.importance, metadata.triggers,
                  metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           LEFT JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'MEMORY.md' AND chunk.source = 'memory'
           ORDER BY chunk.start_line, chunk.id`,
        )
        .all() as Array<{
        text: string;
        importance: number | null;
        triggers: string | null;
        projectKey: string | null;
      }>;
      const fragments = rows.filter((row) => row.triggers === "oversized alpha");

      expect(fragments.length).toBeGreaterThanOrEqual(2);
      expect(fragments.every((row) => row.projectKey === "alpha-key" && row.importance === 8)).toBe(
        true,
      );
      expect(rows.find((row) => row.triggers === "global neighbor")).toMatchObject({
        projectKey: null,
        importance: null,
      });
    } finally {
      await manager.close?.();
    }
  });

  it("re-chunks unchanged files and removes stale rows when the chunking version advances", async () => {
    const curatedContent = [
      "- Alpha entry. <!-- trigger: alpha entry --> <!-- project: alpha-key -->",
      "- Beta entry. <!-- trigger: beta entry --> <!-- project: beta-key -->",
      "- Global entry. <!-- trigger: global entry -->",
    ].join("\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), curatedContent);

    const manager = await getFreshManager(createCfg({ provider: "none" }));
    try {
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const metaRow = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get() as { value: string };
      const currentMeta = JSON.parse(metaRow.value) as MemoryIndexMeta;
      const legacyMeta: MemoryIndexMeta = {
        ...currentMeta,
        chunkingVersion: MEMORY_CHUNKING_VERSION - 1,
      };

      db.prepare("DELETE FROM memory_index_chunks WHERE path = ? AND source = 'memory'").run(
        "MEMORY.md",
      );
      db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, 'memory', 1, 3, ?, 'fts-only', ?, '[]', ?)`,
      ).run(
        "legacy-curated-chunk",
        "MEMORY.md",
        hashText(curatedContent),
        curatedContent,
        Date.now(),
      );
      db.prepare(
        `INSERT INTO memory_index_chunk_provenance (
           chunk_id, origin_class, session_kind, observed_at
         ) VALUES ('legacy-curated-chunk', 'agent', 'unknown', ?)`,
      ).run(Date.now());
      db.prepare(
        `INSERT INTO memory_index_sources (path, source, hash, mtime, size)
         VALUES ('memory/default-diagram.png', 'memory', 'stale-default-media', ?, 3)`,
      ).run(Date.now());
      db.prepare(
        `INSERT INTO memory_index_chunks
         (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (
           'stale-default-media', 'memory/default-diagram.png', 'memory', 1, 1,
           'stale-default-media', 'fts-only', 'Image file: memory/default-diagram.png', '[]', ?
         )`,
      ).run(Date.now());
      db.prepare(
        `INSERT INTO memory_index_chunk_provenance (
           chunk_id, origin_class, session_kind, observed_at
         ) VALUES ('stale-default-media', 'agent', 'unknown', ?)`,
      ).run(Date.now());
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify(legacyMeta),
      );

      await manager.sync({ reason: "test" });

      const rows = db
        .prepare(
          `SELECT chunk.text, metadata.triggers, metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           LEFT JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'MEMORY.md' AND chunk.source = 'memory'
           ORDER BY chunk.start_line`,
        )
        .all();
      expect(rows).toMatchObject([
        { triggers: "alpha entry", projectKey: "alpha-key" },
        { triggers: "beta entry", projectKey: "beta-key" },
        { triggers: "global entry", projectKey: null },
      ]);
      expect(rows).toHaveLength(3);
      expect(
        db
          .prepare(
            "SELECT 1 FROM memory_index_sources WHERE path = 'memory/default-diagram.png' AND source = 'memory'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT 1 FROM memory_index_chunks WHERE path = 'memory/default-diagram.png' AND source = 'memory'",
          )
          .get(),
      ).toBeUndefined();
      expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
      const upgradedMeta = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get() as { value: string };
      expect((JSON.parse(upgradedMeta.value) as MemoryIndexMeta).chunkingVersion).toBe(
        MEMORY_CHUNKING_VERSION,
      );
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

  it("drains retained queued targets through the next idle sync call", async () => {
    const markers = {
      blocker: "BLOCKER LOCKED SYNC 729",
      retained: "RETAINED RETRY TARGET 729",
      trigger: "IDLE TRIGGER TARGET 729",
    };
    const sessionKey = (sessionId: string) => `agent:main:proof:${sessionId}`;
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
    );
    let lock: DatabaseSync | null = null;
    try {
      await manager.sync({ reason: "test-baseline", force: true });
      for (const [sessionId, marker] of Object.entries(markers)) {
        await seedMemoryIndexSessionTranscript({
          sessionId,
          sessionKey: sessionKey(sessionId),
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: marker,
            },
          ],
        });
      }

      const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      lock = new DatabaseSync(dbPath);
      lock.exec("PRAGMA busy_timeout = 0");
      lock.exec("BEGIN EXCLUSIVE");

      const active = manager.sync({
        reason: "test-locked-owner",
        sessions: [
          {
            agentId: "main",
            sessionId: "blocker",
            sessionKey: sessionKey("blocker"),
          },
        ],
      });
      const failedQueued = manager.sync({
        reason: "test-queued-retained",
        sessions: [
          {
            agentId: "main",
            sessionId: "retained",
            sessionKey: sessionKey("retained"),
          },
        ],
      });
      const failures = await Promise.allSettled([active, failedQueued]);
      lock.exec("ROLLBACK");
      lock.close();
      lock = null;
      const describeSqliteFailure = (failure: unknown): string => {
        const details = [String(failure)];
        if (failure && typeof failure === "object") {
          const record = failure as Record<string, unknown>;
          for (const key of ["message", "code"] as const) {
            if (typeof record[key] === "string") {
              details.push(record[key]);
            }
          }
          if (record.cause && typeof record.cause === "object") {
            const cause = record.cause as Record<string, unknown>;
            for (const key of ["message", "code"] as const) {
              if (typeof cause[key] === "string") {
                details.push(cause[key]);
              }
            }
          }
        }
        return details.join(" ");
      };
      for (const result of failures) {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("expected SQLite-locked sync to reject");
        }
        expect(describeSqliteFailure(result.reason)).toMatch(
          /SQLITE_(?:BUSY|LOCKED)|database is (?:busy|locked)/i,
        );
      }

      const ftsMatchCount = (marker: string): number => {
        const observer = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return (
            observer
              .prepare(
                "SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
              )
              .get(`"${marker}"`) as { count: number }
          ).count;
        } finally {
          observer.close();
        }
      };

      expect(ftsMatchCount(markers.retained)).toBe(0);
      expect(ftsMatchCount(markers.trigger)).toBe(0);
      const recoveryState = manager as unknown as {
        syncing: Promise<void> | null;
        queuedSessions: Map<string, unknown>;
        sessionsDirtyFiles: Set<string>;
        sessionsFullRetryDirty: boolean;
      };
      expect(recoveryState.syncing).toBeNull();
      expect(recoveryState.queuedSessions.size).toBe(1);
      expect(recoveryState.sessionsDirtyFiles.size).toBe(0);
      expect(recoveryState.sessionsFullRetryDirty).toBe(false);

      const recoveryProgress = vi.fn();
      const recovery = manager.sync({
        reason: "test-recovery-trigger",
        sessions: [
          {
            agentId: "main",
            sessionId: "trigger",
            sessionKey: sessionKey("trigger"),
          },
        ],
        progress: recoveryProgress,
      });
      // A full sync can claim `syncing` before the retained queue owner resumes.
      // Both owners must settle without the queue awaiting its own promise.
      const competingFullSync = manager.sync({ reason: "test-competing-full-sync" });
      const recoveryResults = await Promise.allSettled([recovery, competingFullSync]);
      expect(recoveryResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

      expect(ftsMatchCount(markers.retained)).toBeGreaterThan(0);
      expect(ftsMatchCount(markers.trigger)).toBeGreaterThan(0);
      expect(recoveryState.queuedSessions.size).toBe(0);
      expect(recoveryProgress).toHaveBeenCalled();
    } finally {
      if (lock) {
        try {
          lock.exec("ROLLBACK");
        } finally {
          lock.close();
        }
      }
      await manager.close?.();
    }
  });

  it("drains retained queued targets from a live rejection transition", async () => {
    const markers = {
      retained: "LIVE REJECTION RETAINED TARGET 729",
      transition: "LIVE REJECTION TRANSITION TARGET 729",
      trigger: "LIVE REJECTION RECOVERY TARGET 729",
    };
    const sessionKey = (sessionId: string) => `agent:main:live-rejection:${sessionId}`;
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
    );
    let resolveActiveSync: (() => void) | undefined;
    const activeSyncGate = new Promise<void>((resolve) => {
      resolveActiveSync = resolve;
    });
    let rejectQueuedSync: ((error: Error) => void) | undefined;
    const queuedSyncGate = new Promise<void>((_resolve, reject) => {
      rejectQueuedSync = reject;
    });
    const owner = manager as unknown as {
      syncing: Promise<void> | null;
      queuedSessions: Map<string, MemorySessionSyncTarget>;
      queuedSessionSync: Promise<void> | null;
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const originalRunSync = owner.runSync.bind(owner);
    const runSyncSpy = vi
      .spyOn(owner, "runSync")
      .mockImplementationOnce(async (params) => await originalRunSync(params))
      .mockImplementationOnce(async () => await activeSyncGate)
      .mockImplementationOnce(async () => await queuedSyncGate)
      .mockImplementation(async (params) => await originalRunSync(params));
    const queuedError = new Error("controlled queued rejection");
    try {
      await manager.sync({ reason: "test-live-rejection-baseline", force: true });
      for (const [sessionId, marker] of Object.entries(markers)) {
        await seedMemoryIndexSessionTranscript({
          sessionId,
          sessionKey: sessionKey(sessionId),
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: marker,
            },
          ],
        });
      }

      const active = manager.sync({
        reason: "test-live-rejection-owner",
        sessions: [
          {
            agentId: "main",
            sessionId: "active",
            sessionKey: sessionKey("active"),
          },
        ],
      });
      const queuedProgress = vi.fn();
      const failedQueued = manager.sync({
        reason: "test-live-rejection-queued",
        sessions: [
          {
            agentId: "main",
            sessionId: "retained",
            sessionKey: sessionKey("retained"),
          },
        ],
        force: true,
        progress: queuedProgress,
      });
      const failuresPromise = Promise.allSettled([active, failedQueued]);
      resolveActiveSync?.();
      await vi.waitFor(() => {
        expect(runSyncSpy).toHaveBeenCalledTimes(3);
        expect(owner.syncing).not.toBeNull();
        expect(owner.queuedSessionSync).not.toBeNull();
      });
      const rejectingQueuedSync = owner.syncing;
      if (!rejectingQueuedSync) {
        throw new Error("expected a live queued sync");
      }

      let resolveTransitionResult!: (result: PromiseSettledResult<void>) => void;
      const transitionResult = new Promise<PromiseSettledResult<void>>((resolve) => {
        resolveTransitionResult = resolve;
      });
      let transitionState:
        | { syncingNull: boolean; queueOwnerLive: boolean; queuedTargets: number }
        | undefined;
      const transitionProgress = vi.fn();
      void rejectingQueuedSync.catch(() => {
        transitionState = {
          syncingNull: owner.syncing === null,
          queueOwnerLive: owner.queuedSessionSync !== null,
          queuedTargets: owner.queuedSessions.size,
        };
        const transitionCall = manager.sync({
          reason: "test-live-rejection-transition",
          sessions: [
            {
              agentId: "main",
              sessionId: "transition",
              sessionKey: sessionKey("transition"),
            },
          ],
          progress: transitionProgress,
        });
        void transitionCall.then(
          (value) => resolveTransitionResult({ status: "fulfilled", value }),
          (reason: unknown) => resolveTransitionResult({ status: "rejected", reason }),
        );
      });

      rejectQueuedSync?.(queuedError);
      const failures = await failuresPromise;
      const transitionFailure = await transitionResult;
      expect(failures[0]?.status).toBe("fulfilled");
      expect(failures[1]?.status).toBe("rejected");
      expect(transitionFailure.status).toBe("rejected");
      if (failures[1]?.status !== "rejected" || transitionFailure.status !== "rejected") {
        throw new Error("expected shared queued rejection");
      }
      expect(failures[1].reason).toBe(queuedError);
      expect(transitionFailure.reason).toBe(queuedError);
      expect(transitionState).toEqual({
        syncingNull: true,
        queueOwnerLive: true,
        queuedTargets: 0,
      });
      expect(Array.from(owner.queuedSessions.values())).toEqual([
        {
          agentId: "main",
          sessionId: "transition",
          sessionKey: sessionKey("transition"),
        },
        {
          agentId: "main",
          sessionId: "retained",
          sessionKey: sessionKey("retained"),
        },
      ]);
      expect(queuedProgress).not.toHaveBeenCalled();
      expect(transitionProgress).not.toHaveBeenCalled();

      const recoveryProgress = vi.fn();
      await manager.sync({
        reason: "test-live-rejection-recovery",
        sessions: [
          {
            agentId: "main",
            sessionId: "trigger",
            sessionKey: sessionKey("trigger"),
          },
        ],
        progress: recoveryProgress,
      });

      const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const observer = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const indexedCount = (marker: string) =>
          (
            observer
              .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
              .get(`%${marker}%`) as { count: number }
          ).count;
        expect(indexedCount(markers.retained)).toBeGreaterThan(0);
        expect(indexedCount(markers.transition)).toBeGreaterThan(0);
        expect(indexedCount(markers.trigger)).toBeGreaterThan(0);
      } finally {
        observer.close();
      }
      expect(owner.queuedSessions.size).toBe(0);
      expect(recoveryProgress).toHaveBeenCalled();
      expect(transitionProgress).not.toHaveBeenCalled();
    } finally {
      resolveActiveSync?.();
      rejectQueuedSync?.(queuedError);
      await manager.close?.();
      runSyncSpy.mockRestore();
    }
  });

  it("clears retained queued targets when close interrupts a competing sync", async () => {
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
    );
    let resolveFullSync: (() => void) | undefined;
    const fullSyncGate = new Promise<void>((resolve) => {
      resolveFullSync = resolve;
    });
    const owner = manager as unknown as {
      closing: boolean;
      closed: boolean;
      queuedSessions: Map<string, MemorySessionSyncTarget>;
      queuedProgressCallbacks: Set<NonNullable<MemorySyncParams["progress"]>>;
      queuedForce: boolean;
      syncAdmitted: (params?: MemorySyncParams) => Promise<void>;
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const syncAdmitted = vi.spyOn(owner, "syncAdmitted");
    const runSyncSpy = vi.spyOn(owner, "runSync").mockReturnValueOnce(fullSyncGate);
    const progress = vi.fn();
    owner.queuedSessions.set("retained", {
      agentId: "main",
      sessionId: "retained-close",
      sessionKey: "agent:main:retained-close",
    });

    try {
      const recovery = manager.sync({
        reason: "test-close-recovery",
        sessions: [
          {
            agentId: "main",
            sessionId: "trigger-close",
            sessionKey: "agent:main:trigger-close",
          },
        ],
        force: true,
        progress,
      });
      const competingFullSync = manager.sync({ reason: "test-close-competing-full-sync" });

      await vi.waitFor(() => {
        expect(syncAdmitted).toHaveBeenCalledTimes(2);
      });
      const closing = manager.close?.() ?? Promise.resolve();
      expect(owner.closing).toBe(true);
      resolveFullSync?.();

      await expect(Promise.all([recovery, competingFullSync, closing])).resolves.toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(runSyncSpy).toHaveBeenCalledTimes(1);
      expect(syncAdmitted).toHaveBeenCalledTimes(2);
      expect(owner.closed).toBe(true);
      expect(owner.queuedSessions.size).toBe(0);
      expect(owner.queuedProgressCallbacks.size).toBe(0);
      expect(owner.queuedForce).toBe(false);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      resolveFullSync?.();
      await manager.close?.();
      runSyncSpy.mockRestore();
      syncAdmitted.mockRestore();
    }
  });

  it("clears retained queued targets after failure when the manager closes", async () => {
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
    );
    let resolveActiveSync: (() => void) | undefined;
    const activeSyncGate = new Promise<void>((resolve) => {
      resolveActiveSync = resolve;
    });
    const owner = manager as unknown as {
      closed: boolean;
      queuedArchiveFiles: Set<string>;
      queuedSessions: Map<string, MemorySessionSyncTarget>;
      queuedProgressCallbacks: Set<NonNullable<MemorySyncParams["progress"]>>;
      queuedForce: boolean;
      queuedSessionSync: Promise<void> | null;
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSyncSpy = vi
      .spyOn(owner, "runSync")
      .mockReturnValueOnce(activeSyncGate)
      .mockRejectedValueOnce(new Error("test queued failure"));
    const progress = vi.fn();

    try {
      const active = manager.sync({
        reason: "test-close-after-failure-owner",
        sessions: [
          {
            agentId: "main",
            sessionId: "active-close-after-failure",
            sessionKey: "agent:main:active-close-after-failure",
          },
        ],
      });
      const failedQueued = manager.sync({
        reason: "test-close-after-failure-queued",
        sessions: [
          {
            agentId: "main",
            sessionId: "retained-close-after-failure",
            sessionKey: "agent:main:retained-close-after-failure",
          },
        ],
        archiveFiles: ["/tmp/retained-close-after-failure.jsonl"],
        force: true,
        progress,
      });
      const queuedRejection = expect(failedQueued).rejects.toThrow("test queued failure");

      resolveActiveSync?.();
      await active;
      await queuedRejection;

      expect(runSyncSpy).toHaveBeenCalledTimes(2);
      expect(owner.queuedArchiveFiles).toEqual(
        new Set(["/tmp/retained-close-after-failure.jsonl"]),
      );
      expect(Array.from(owner.queuedSessions.values())).toEqual([
        {
          agentId: "main",
          sessionId: "retained-close-after-failure",
          sessionKey: "agent:main:retained-close-after-failure",
        },
      ]);
      expect(owner.queuedForce).toBe(true);
      expect(owner.queuedProgressCallbacks.size).toBe(0);
      expect(owner.queuedSessionSync).toBeNull();

      await manager.close?.();

      expect(owner.closed).toBe(true);
      expect(owner.queuedArchiveFiles.size).toBe(0);
      expect(owner.queuedSessions.size).toBe(0);
      expect(owner.queuedProgressCallbacks.size).toBe(0);
      expect(owner.queuedForce).toBe(false);
    } finally {
      resolveActiveSync?.();
      await manager.close?.();
      runSyncSpy.mockRestore();
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
    const concurrentClosePromise = manager.close();
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
    await Promise.all([closePromise, concurrentClosePromise]);
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
      const originalRunSync = (
        manager as unknown as {
          runSync: (params?: {
            reason?: string;
            force?: boolean;
            archiveFiles?: string[];
            progress?: (update: unknown) => void;
          }) => Promise<void>;
        }
      ).runSync.bind(manager);
      (
        manager as unknown as {
          runSync: typeof originalRunSync;
        }
      ).runSync = async (params) => {
        resolve();
        await new Promise<void>((syncResolve) => {
          releaseSync = syncResolve;
        });
        await originalRunSync(params);
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

  it("indexes multimodal files only from extra paths", async () => {
    const mediaDir = path.join(workspaceDir, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));
    await fs.writeFile(path.join(memoryDir, "default-diagram.png"), Buffer.from("png"));

    const cfg = createCfg({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);

    const db = Reflect.get(manager, "db") as DatabaseSync;
    const indexedMediaPaths = () =>
      (
        db
          .prepare(
            "SELECT path FROM memory_index_chunks WHERE source = 'memory' AND path LIKE '%.png' ORDER BY path",
          )
          .all() as Array<{ path: string }>
      ).map((row) => row.path);
    expect(indexedMediaPaths()).toEqual(["media-memory/diagram.png"]);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);
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

  it("reports persisted vector index state on the unprobed status path", async () => {
    const cfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const emptyManager = await getFreshManager(cfg, "status");
    try {
      const emptyStatus = emptyManager.status();
      expect(emptyStatus.chunks).toBe(0);
      expect(emptyStatus.vector?.storeAvailable).toBeUndefined();
      expect(emptyStatus.vector?.index).toEqual({ state: "empty" });
    } finally {
      await emptyManager.close?.();
    }

    const indexingManager = await getFreshManager(cfg);
    try {
      await indexingManager.sync({ reason: "test", force: true });
      expect(indexingManager.status().chunks).toBeGreaterThan(0);
    } finally {
      await indexingManager.close?.();
    }

    const statusManager = await getFreshManager(cfg, "status");
    try {
      expect(Reflect.get(statusManager, "vector")).toMatchObject({ available: null, dims: 4 });
      expect(statusManager.status().vector).toMatchObject({
        index: { state: "complete" },
        storeAvailable: undefined,
      });

      const db = Reflect.get(statusManager, "db") as DatabaseSync;
      db.prepare("UPDATE memory_index_meta SET value = '1' WHERE key = ?").run(
        "memory_vector_rebuild_v1",
      );
      expect(statusManager.status().vector?.index).toEqual({ state: "incomplete" });
    } finally {
      await statusManager.close?.();
    }
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

  it("preserves trusted per-line provenance through session indexing", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-provenance",
      });
      if (!manager) {
        return;
      }

      await seedMemoryIndexSessionTranscript({
        sessionId: "session-provenance",
        messages: [
          {
            role: "user",
            senderIsOwner: true,
            timestamp: "2026-07-01T10:00:00.000Z",
            content: "The owner prefers green tea.",
          },
        ],
      });

      await manager.sync({ reason: "test", force: true });
      const results = await manager.search("owner prefers green tea", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.provenance).toEqual({
        originClass: "owner",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
      });
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

  it("prunes removed sessions without re-embedding unchanged survivors", async () => {
    const cfg = createCfg({
      provider: "gemini",
      sources: ["sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const stateDirName = ".state-status-stale-session-test";
    setMemoryIndexStateDir(path.join(workspaceDir, stateDirName));
    const sessionId = "status-stale-session-test";
    const sessionKey = `agent:main:memory:${sessionId}`;
    const survivorId = "status-stale-session-survivor";
    const survivorKey = `agent:main:memory:${survivorId}`;
    const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
    try {
      await seedMemoryIndexSessionTranscript({
        sessionId,
        sessionKey,
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: "Deleted session index canary ORBIT-DELETE-91.",
          },
        ],
      });
      await seedMemoryIndexSessionTranscript({
        sessionId: survivorId,
        sessionKey: survivorKey,
        messages: [
          {
            role: "user",
            timestamp: 2,
            content: "Surviving session index canary ORBIT-SURVIVE-92.",
          },
        ],
      });

      const initial = await getFreshManager(cfg, "cli");
      managersForCleanup.add(initial);
      await initial.sync({ reason: "cli", force: true });
      await expect(
        initial.search("ORBIT-DELETE-91", { minScore: 0, sources: ["sessions"] }),
      ).resolves.not.toEqual([]);
      await initial.close?.();
      const agentDb = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
      agentDb.exec("DELETE FROM memory_embedding_cache");
      agentDb.close();
      embedBatchCalls = 0;

      await expect(
        deleteSessionEntry({
          agentId: "main",
          archiveTranscript: false,
          expectedSessionId: sessionId,
          sessionKey,
          storePath,
        }),
      ).resolves.toBe(true);

      const statusManager = await getFreshManager(cfg, "status");
      managersForCleanup.add(statusManager);
      expect(statusManager.status().dirty).toBe(true);

      await statusManager.sync({ reason: "cli" });
      expect(embedBatchCalls).toBe(0);
      const deletedResults = await statusManager.search("ORBIT-DELETE-91", {
        minScore: 0,
        sources: ["sessions"],
      });
      expect(deletedResults.some((result) => result.path.includes(sessionId))).toBe(false);
      await expect(
        statusManager.search("ORBIT-SURVIVE-92", { minScore: 0, sources: ["sessions"] }),
      ).resolves.not.toEqual([]);
      const db = Reflect.get(statusManager, "db") as DatabaseSync;
      const sourceCount = db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE source = 'sessions'")
        .get() as { count: number };
      expect(sourceCount.count).toBe(1);
    } finally {
      restoreMemoryIndexStateDir();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
