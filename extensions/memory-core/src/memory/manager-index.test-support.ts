import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type GetMemorySearchManager = typeof import("./index.js").getMemorySearchManager;
type ManagerConfig = Parameters<GetMemorySearchManager>[0]["cfg"];
type ManagerResult = Awaited<ReturnType<GetMemorySearchManager>>;

type ManagerIndexFixtureConfig = {
  extraPaths?: string[];
  sources?: Array<"memory" | "sessions">;
  sessionMemory?: boolean;
  rememberAcrossConversations?: boolean;
  provider?: string;
  fallback?: "none" | "gemini" | "fallback-provider";
  providerAliases?: NonNullable<NonNullable<ManagerConfig["models"]>["providers"]>;
  batchEnabled?: boolean;
  model?: string;
  outputDimensionality?: number;
  multimodal?: {
    enabled?: boolean;
    modalities?: Array<"image" | "audio" | "all">;
    maxFileBytes?: number;
  };
  vectorEnabled?: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
  cacheEnabled?: boolean;
  minScore?: number;
};

type ProviderCall = {
  provider?: string;
  model?: string;
  outputDimensionality?: number;
};

type ProviderControls = {
  embedQueryCalls: number;
  embeddedQueryTexts: string[];
  embedBatchCalls: number;
  embeddedBatchTexts: string[];
  embedBatchInputCalls: number;
  embeddedBatchInputs: EmbeddingInput[][];
  providerRuntimeBatchCalls: string[][];
  providerRuntimeBatchGate: Promise<void> | null;
  providerRuntimeBatchEntered: ((activeCalls: number, texts: readonly string[]) => void) | null;
  providerRuntimeBatchErrors: unknown[];
  providerRuntimeBatchFailuresRemaining: number;
  providerRuntimeActiveBatchCalls: number;
  providerRuntimeMaxActiveBatchCalls: number;
  providerCloseCalls: number;
  providerCloseFailuresRemaining: number;
  providerCloseFailure: unknown;
  providerCreationFailure: string | null;
  providerNullResult: string | null;
  providerCloseGate: Promise<void> | null;
  providerInitGate: Promise<void> | null;
  providerCalls: ProviderCall[];
  forceNoProvider: boolean;
  identityAlias: {
    provider: string;
    canonicalModel: string;
    cacheModel: string;
  };
  createLocalWorkerExitError: () => Error;
};

export type ManagerIndexFixture = {
  paths: {
    readonly root: string;
    readonly workspace: string;
    readonly memory: string;
  };
  provider: ProviderControls;
  createConfig: (params: ManagerIndexFixtureConfig) => ManagerConfig;
  requireManager: (result: ManagerResult, missingMessage?: string) => MemoryIndexManager;
  trackManager: (manager: MemoryIndexManager) => void;
  resetManager: (manager: MemoryIndexManager) => void;
  getPersistentManager: (cfg: ManagerConfig) => Promise<MemoryIndexManager>;
  getFreshManager: (
    cfg: ManagerConfig,
    purpose?: "default" | "status" | "cli",
    inspectSources?: boolean,
  ) => Promise<MemoryIndexManager>;
  getFtsSessionManager: (params: { stateDirName: string }) => Promise<MemoryIndexManager | null>;
  seedSessionTranscript: (params: {
    messages: Array<{
      content: string;
      role: "assistant" | "user";
      senderIsOwner?: boolean;
      timestamp: number | string;
    }>;
    sessionId: string;
    sessionKey?: string;
  }) => Promise<void>;
  setStateDir: (stateDir: string) => void;
  restoreStateDir: () => void;
};

const providerState = vi.hoisted(() => ({
  embedQueryCalls: 0,
  embeddedQueryTexts: [] as string[],
  embedBatchCalls: 0,
  embeddedBatchTexts: [] as string[],
  embedBatchInputCalls: 0,
  embeddedBatchInputs: [] as EmbeddingInput[][],
  providerRuntimeBatchCalls: [] as string[][],
  providerRuntimeBatchGate: null as Promise<void> | null,
  providerRuntimeBatchEntered: null as
    | ((activeCalls: number, texts: readonly string[]) => void)
    | null,
  providerRuntimeBatchErrors: [] as unknown[],
  providerRuntimeBatchFailuresRemaining: 0,
  providerRuntimeActiveBatchCalls: 0,
  providerRuntimeMaxActiveBatchCalls: 0,
  providerCloseCalls: 0,
  providerCloseFailuresRemaining: 0,
  providerCloseFailure: new Error("provider close failed") as unknown,
  providerCreationFailure: null as string | null,
  providerNullResult: null as string | null,
  providerCloseGate: null as Promise<void> | null,
  providerInitGate: null as Promise<void> | null,
  providerCalls: [] as ProviderCall[],
  forceNoProvider: false,
  identityAlias: {
    provider: "identity-alias-test",
    canonicalModel: "hf:fixture/default-model.gguf",
    cacheModel: "/fixture/cache/default-model.gguf",
  },
}));

vi.setConfig({ testTimeout: 240_000 });

afterAll(() => {
  vi.resetConfig();
});

function createLocalWorkerExitError(): Error {
  return Object.assign(new Error("Local embedding worker exited unexpectedly (exit code 134)"), {
    code: "LOCAL_EMBEDDING_WORKER_EXITED",
    reason: "exit",
    exitCode: 134,
  });
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
  const resolveFallbackModel = (providerId: string, fallbackSourceModel: string) =>
    providerId === "gemini" || providerId === "fallback-provider"
      ? `${providerId}-embed`
      : fallbackSourceModel;
  return {
    ...actual,
    resolveEmbeddingProviderFallbackModel: resolveFallbackModel,
    resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
      providerId === "local" ? "local" : "remote",
    resolveEmbeddingProviderIndexIdentity: (
      options: Parameters<typeof actual.resolveEmbeddingProviderIndexIdentity>[0],
    ) =>
      options.provider === providerState.identityAlias.provider
        ? {
            provider: {
              id: providerState.identityAlias.provider,
              model: providerState.identityAlias.canonicalModel,
            },
            cacheKeyData: {
              provider: providerState.identityAlias.provider,
              model: providerState.identityAlias.canonicalModel,
            },
            aliases: [
              {
                model: providerState.identityAlias.cacheModel,
                cacheKeyData: {
                  provider: providerState.identityAlias.provider,
                  model: providerState.identityAlias.cacheModel,
                },
              },
            ],
          }
        : {
            provider: {
              id: options.config.models?.providers?.[options.provider]?.api ?? options.provider,
              model: options.model.trim() || resolveFallbackModel(options.provider, ""),
            },
          },
    createEmbeddingProvider: async (options: ProviderCall) => {
      providerState.providerCalls.push({
        provider: options.provider,
        model: options.model,
        outputDimensionality: options.outputDimensionality,
      });
      await providerState.providerInitGate;
      if (options.provider === providerState.providerCreationFailure) {
        throw new Error(`provider creation failed: ${options.provider}`);
      }
      if (options.provider === providerState.providerNullResult) {
        return {
          provider: null,
          requestedProvider: options.provider,
          providerUnavailableReason: `provider unavailable: ${options.provider}`,
        };
      }
      if (providerState.forceNoProvider) {
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
        options.provider === providerState.identityAlias.provider ||
        options.provider === "ollama"
          ? options.provider
          : "mock";
      const requestedModel = options.model ?? "mock-embed";
      const model =
        providerId === providerState.identityAlias.provider &&
        (requestedModel === providerState.identityAlias.canonicalModel ||
          requestedModel === providerState.identityAlias.cacheModel)
          ? providerState.identityAlias.canonicalModel
          : requestedModel;
      return {
        requestedProvider: options.provider ?? "openai",
        provider: {
          id: providerId,
          model,
          close: async () => {
            providerState.providerCloseCalls += 1;
            await providerState.providerCloseGate;
            if (providerState.providerCloseFailuresRemaining > 0) {
              providerState.providerCloseFailuresRemaining -= 1;
              throw providerState.providerCloseFailure;
            }
          },
          embed: async (input: EmbeddingInput) => {
            const text = typeof input === "string" ? input : input.text;
            providerState.embedQueryCalls += 1;
            providerState.embeddedQueryTexts.push(text);
            return embedText(text);
          },
          embedBatch: async (inputs: EmbeddingInput[]) => {
            if (providerId === "gemini" || providerId === "fallback-provider") {
              const structuredInputs = inputs.filter(
                (input): input is Exclude<EmbeddingInput, string> =>
                  typeof input !== "string" && input.parts?.length !== undefined,
              );
              if (structuredInputs.length > 0) {
                providerState.embedBatchInputCalls += 1;
                providerState.embeddedBatchInputs.push(inputs);
                return structuredInputs.map((input) => {
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
              }
            }
            const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
            providerState.embedBatchCalls += 1;
            providerState.embeddedBatchTexts.push(...texts);
            return texts.map(embedText);
          },
        },
        ...(providerId === providerState.identityAlias.provider
          ? {
              runtime: {
                id: providerId,
                cacheKeyData: {
                  provider: providerId,
                  model: providerState.identityAlias.canonicalModel,
                },
                indexIdentityAliases: [
                  {
                    model: providerState.identityAlias.cacheModel,
                    cacheKeyData: {
                      provider: providerId,
                      model: providerState.identityAlias.cacheModel,
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
                    providerState.providerRuntimeActiveBatchCalls += 1;
                    providerState.providerRuntimeMaxActiveBatchCalls = Math.max(
                      providerState.providerRuntimeMaxActiveBatchCalls,
                      providerState.providerRuntimeActiveBatchCalls,
                    );
                    try {
                      providerState.providerRuntimeBatchEntered?.(
                        providerState.providerRuntimeActiveBatchCalls,
                        batch.chunks.map((chunk) => chunk.text),
                      );
                      await providerState.providerRuntimeBatchGate;
                      providerState.providerRuntimeBatchCalls.push(
                        batch.chunks.map((chunk) => chunk.text),
                      );
                      if (providerState.providerRuntimeBatchErrors.length > 0) {
                        throw providerState.providerRuntimeBatchErrors.shift();
                      }
                      if (providerState.providerRuntimeBatchFailuresRemaining > 0) {
                        providerState.providerRuntimeBatchFailuresRemaining -= 1;
                        throw new Error("provider runtime batch failed");
                      }
                      return batch.chunks.map((chunk) => embedText(chunk.text));
                    } finally {
                      providerState.providerRuntimeActiveBatchCalls -= 1;
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

export function createManagerIndexFixture(deps: {
  getMemorySearchManager: GetMemorySearchManager;
  closeAllMemorySearchManagers: typeof import("./index.js").closeAllMemorySearchManagers;
}): ManagerIndexFixture {
  const provider = Object.assign(providerState, { createLocalWorkerExitError });
  let root = "";
  let workspace = "";
  let memory = "";
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const managers = new Set<MemoryIndexManager>();

  const setStateDir = (stateDir: string): void => {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
  };

  const restoreStateDir = (): void => {
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  };

  const resetManager = (manager: MemoryIndexManager): void => {
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
  };

  const createConfig = (params: ManagerIndexFixtureConfig): ManagerConfig =>
    isolateMemoryManagerTestConfig({
      memory: {
        search: {
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          model: params.model ?? "mock-embed",
          fallback: params.fallback,
          outputDimensionality: params.outputDimensionality,
          store: {
            fts: params.ftsTokenizer ? { tokenizer: params.ftsTokenizer } : undefined,
            vector: params.vectorEnabled !== undefined ? { enabled: params.vectorEnabled } : {},
          },
          remote: params.batchEnabled ? { batch: { enabled: true } } : undefined,
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
        defaults: { workspace },
        list: [{ id: "main", default: true }],
      },
      models: params.providerAliases ? { providers: params.providerAliases } : undefined,
    } as OpenClawConfig);

  const requireManager = (
    result: ManagerResult,
    missingMessage = "manager missing",
  ): MemoryIndexManager => {
    if (!result.manager) {
      throw new Error(missingMessage);
    }
    return result.manager as unknown as MemoryIndexManager;
  };

  const trackManager = (manager: MemoryIndexManager): void => {
    managers.add(manager);
  };

  const getPersistentManager = async (cfg: ManagerConfig): Promise<MemoryIndexManager> => {
    const manager = requireManager(await deps.getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(manager);
    resetManager(manager);
    return manager;
  };

  const getFreshManager = async (
    cfg: ManagerConfig,
    purpose?: "default" | "status" | "cli",
    inspectSources?: boolean,
  ): Promise<MemoryIndexManager> => {
    const manager = requireManager(
      await deps.getMemorySearchManager({ cfg, agentId: "main", purpose, inspectSources }),
    );
    trackManager(manager);
    return manager;
  };

  const seedSessionTranscript: ManagerIndexFixture["seedSessionTranscript"] = async (params) => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = params.sessionKey ?? `agent:main:memory:${params.sessionId}`;
    const updatedAt = Date.now();
    await fs.mkdir(sessionsDir, { recursive: true });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId: params.sessionId, updatedAt },
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
  };

  const getFtsSessionManager: ManagerIndexFixture["getFtsSessionManager"] = async (params) => {
    providerState.forceNoProvider = true;
    setStateDir(path.join(workspace, params.stateDirName));
    const cfg = createConfig({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const manager = requireManager(await deps.getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(manager);
    resetManager(manager);
    return manager.status().fts?.available ? manager : null;
  };

  beforeAll(async () => {
    const rawRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-mem-fixtures-"),
    );
    root = await fs.realpath(rawRoot);
    workspace = path.join(root, "workspace");
    memory = path.join(workspace, "memory");
  });

  afterAll(async () => {
    await Promise.all(Array.from(managers).map((manager) => manager.close()));
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(Array.from(managers).map((manager) => manager.close()));
    await deps.closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetMemoryCoreDreamingStateForTests();
    clearRegistry();
    managers.clear();
    restoreStateDir();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    clearRegistry();
    providerState.embedQueryCalls = 0;
    providerState.embeddedQueryTexts = [];
    providerState.embedBatchCalls = 0;
    providerState.embeddedBatchTexts = [];
    providerState.embedBatchInputCalls = 0;
    providerState.embeddedBatchInputs = [];
    providerState.providerRuntimeBatchCalls = [];
    providerState.providerRuntimeBatchGate = null;
    providerState.providerRuntimeBatchEntered = null;
    providerState.providerRuntimeBatchErrors = [];
    providerState.providerRuntimeBatchFailuresRemaining = 0;
    providerState.providerRuntimeActiveBatchCalls = 0;
    providerState.providerRuntimeMaxActiveBatchCalls = 0;
    providerState.providerCloseCalls = 0;
    providerState.providerCloseFailuresRemaining = 0;
    providerState.providerCloseFailure = new Error("provider close failed");
    providerState.providerCreationFailure = null;
    providerState.providerNullResult = null;
    providerState.providerCloseGate = null;
    providerState.providerInitGate = null;
    providerState.providerCalls = [];
    providerState.forceNoProvider = false;

    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(memory, { recursive: true });
    setStateDir(path.join(workspace, ".state-memory-index"));
    await configureMemoryCoreDreamingStateForTests();
    await fs.writeFile(
      path.join(memory, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  return {
    paths: {
      get root() {
        return root;
      },
      get workspace() {
        return workspace;
      },
      get memory() {
        return memory;
      },
    },
    provider,
    createConfig,
    requireManager,
    trackManager,
    resetManager,
    getPersistentManager,
    getFreshManager,
    getFtsSessionManager,
    seedSessionTranscript,
    setStateDir,
    restoreStateDir,
  };
}
