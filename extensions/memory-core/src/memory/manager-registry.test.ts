// Memory Core tests cover manager registry behavior.
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
import {
  closeAllMemoryIndexManagers,
  closeMemoryIndexManagersForAgent,
  MemoryIndexManager as RuntimeMemoryIndexManager,
} from "./manager.js";
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

  async function getFreshManager(
    cfg: TestCfg,
    purpose?: "default" | "status" | "cli",
  ): Promise<MemoryIndexManager> {
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main", purpose }));
    managersForCleanup.add(manager);
    return manager;
  }

  it("waits for scoped manager close before initializing a replacement", async () => {
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
    const closePromise = closeMemoryIndexManagersForAgent({ agentId: "main" });
    const callsBeforeReplacement = providerCalls.length;
    const secondPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    const concurrentSecondPromise = getMemorySearchManager({ cfg, agentId: "main" }).then(
      (result) => requireManager(result),
    );
    const secondProbe = secondPromise.then(async (manager) => {
      await manager.probeEmbeddingAvailability();
    });
    let secondSettled = false;
    void secondPromise.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    try {
      await vi.waitFor(() => {
        expect(providerCloseCalls).toBe(1);
      });
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }
    await closePromise;
    const second = await secondPromise;
    const concurrentSecond = await concurrentSecondPromise;
    await secondProbe;
    managersForCleanup.add(second);
    expect(second === first).toBe(false);
    expect(concurrentSecond).toBe(second);

    const third = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    managersForCleanup.add(third);
    expect(third).toBe(second);
  });

  it("does not reuse a cached manager after direct close starts", async () => {
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

    const closePromise = first.close();
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    let replacementSettled = false;
    void replacementPromise.then(
      () => {
        replacementSettled = true;
      },
      () => {
        replacementSettled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(providerCloseCalls).toBe(1));
      await Promise.resolve();
      expect(replacementSettled).toBe(false);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    await closePromise;
    const replacement = await replacementPromise;
    managersForCleanup.add(replacement);
    expect(replacement === first).toBe(false);
  });

  it("serializes concurrent acquisitions with different cache identities", async () => {
    const firstCfg = createCfg({
      model: "first-model",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg: firstCfg, agentId: "main" }));
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const secondPromise = getMemorySearchManager({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    }).then((result) => requireManager(result));
    await vi.waitFor(() => expect(providerCloseCalls).toBe(1));
    const thirdPromise = getMemorySearchManager({
      cfg: createCfg({ model: "third-model" }),
      agentId: "main",
    }).then((result) => requireManager(result));
    try {
      await Promise.resolve();
      expect(providerCalls).toHaveLength(1);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    managersForCleanup.add(second);
    managersForCleanup.add(third);
    expect(second === first).toBe(false);
    expect(third === second).toBe(false);
    expect((second as unknown as { closed: boolean }).closed).toBe(true);
    expect((third as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("canonicalizes agent ids before builtin manager acquisition", async () => {
    const cfg = createCfg({ model: "canonical-model" });
    const first = await RuntimeMemoryIndexManager.get({ cfg, agentId: "Main-Agent" });
    const second = await RuntimeMemoryIndexManager.get({ cfg, agentId: "main-agent" });
    if (!first || !second) {
      throw new Error("Expected canonical memory index managers");
    }
    managersForCleanup.add(first);
    managersForCleanup.add(second);
    expect(second).toBe(first);
  });

  it("retires the prior builtin manager when an agent workspace changes", async () => {
    const firstCfg = createCfg({ model: "workspace-model" });
    const secondCfg = createCfg({ model: "workspace-model" });
    if (!firstCfg.agents?.defaults || !secondCfg.agents?.defaults) {
      throw new Error("Expected agent defaults");
    }
    firstCfg.agents.defaults.workspace = path.join(fixtureRoot, "workspace-a");
    secondCfg.agents.defaults.workspace = path.join(fixtureRoot, "workspace-b");

    const first = await RuntimeMemoryIndexManager.get({ cfg: firstCfg, agentId: "main" });
    const second = await RuntimeMemoryIndexManager.get({ cfg: secondCfg, agentId: "main" });
    if (!first || !second) {
      throw new Error("Expected workspace memory index managers");
    }
    managersForCleanup.add(first);
    managersForCleanup.add(second);
    expect(second === first).toBe(false);
    expect((first as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("does not block another agent while one scope retires its manager", async () => {
    const firstCfg = createCfg({
      model: "first-model",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg: firstCfg, agentId: "main" }));
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const replacementPromise = getMemorySearchManager({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    });
    await vi.waitFor(() => expect(providerCloseCalls).toBe(1));
    const otherAgentPromise = getMemorySearchManager({
      cfg: createCfg({ model: "other-model" }),
      agentId: "other",
    });
    let otherAgentSettled = false;
    void otherAgentPromise.then(
      () => {
        otherAgentSettled = true;
      },
      () => {
        otherAgentSettled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(otherAgentSettled).toBe(true));
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    const otherAgent = requireManager(await otherAgentPromise);
    const replacement = requireManager(await replacementPromise);
    managersForCleanup.add(otherAgent);
    managersForCleanup.add(replacement);
    expect((otherAgent as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("global teardown waits for an admitted builtin manager replacement", async () => {
    const first = await RuntimeMemoryIndexManager.get({
      cfg: createCfg({ model: "first-model" }),
      agentId: "main",
    });
    if (!first) {
      throw new Error("Expected first memory index manager");
    }
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const replacementPromise = RuntimeMemoryIndexManager.get({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    });
    await vi.waitFor(() => expect(providerCloseCalls).toBe(1));
    const globalClosePromise = closeAllMemoryIndexManagers();
    let globalCloseSettled = false;
    void globalClosePromise.then(
      () => {
        globalCloseSettled = true;
      },
      () => {
        globalCloseSettled = true;
      },
    );
    try {
      await Promise.resolve();
      expect(globalCloseSettled).toBe(false);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    await globalClosePromise;
    if (!replacement) {
      throw new Error("Expected replacement memory index manager");
    }
    managersForCleanup.add(replacement);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("retains a failed scoped close owner until provider retirement succeeds", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    providerCloseFailuresRemaining = 2;

    await expect(closeMemoryIndexManagersForAgent({ agentId: "main" })).rejects.toThrow(
      "provider close failed",
    );
    expect(providerCloseCalls).toBe(2);

    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const callsBeforeReplacement = providerCalls.length;
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    try {
      await vi.waitFor(() => expect(providerCloseCalls).toBe(3));
      expect(providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    managersForCleanup.add(replacement);
    expect(replacement === first).toBe(false);
  });

  it("retains a failed global close owner until provider retirement succeeds", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    managersForCleanup.add(first);
    await first.probeEmbeddingAvailability();
    providerCloseFailuresRemaining = 2;
    providerCloseFailure = undefined;

    let globalCloseRejected = false;
    await closeAllMemorySearchManagers().then(
      () => {},
      () => {
        globalCloseRejected = true;
      },
    );
    expect(globalCloseRejected).toBe(true);
    expect(providerCloseCalls).toBe(2);

    let releaseProviderClose: () => void = () => {};
    providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const callsBeforeReplacement = providerCalls.length;
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    let concurrentGlobalClose: Promise<void> = Promise.resolve();
    try {
      await vi.waitFor(() => expect(providerCloseCalls).toBe(3));
      expect(providerCalls).toHaveLength(callsBeforeReplacement);
      concurrentGlobalClose = closeAllMemorySearchManagers();
    } finally {
      releaseProviderClose();
      providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    await concurrentGlobalClose;
    managersForCleanup.add(replacement);
    expect(replacement === first).toBe(false);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(false);
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
});
