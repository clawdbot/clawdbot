import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const mocks = vi.hoisted(() => ({
  acquireRuntimeLease: vi.fn(),
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  publishedGeneration: "A",
  readGeneration: (() => "unscoped") as () => string,
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntimeLease,
}));

vi.mock("../plugins/runtime/generation-scope.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const generation = new AsyncLocalStorage<string>();
  mocks.readGeneration = () => generation.getStore() ?? mocks.publishedGeneration;
  return {
    withPluginRuntimeGenerationScope: (snapshot: { testGeneration?: string }, run: () => unknown) =>
      generation.run(snapshot.testGeneration ?? "unknown", run),
  };
});

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: Model) => model,
  applyLocalNoAuthHeaderOverride: (model: Model) => model,
  formatMissingAuthError: vi.fn(),
  getApiKeyForModelCore: mocks.getApiKeyForModel,
  resolveApiKeyForProviderCore: mocks.getApiKeyForModel,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  initializeModelRegistryRuntime: vi.fn(),
  getModelRegistryRuntime: () => ({ llmRuntime: { registry: {}, streamSimple: vi.fn() } }),
}));

import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";

beforeEach(() => {
  mocks.publishedGeneration = "A";
  mocks.acquireRuntimeLease.mockReset();
  mocks.getApiKeyForModel.mockReset();
  mocks.prepareProviderRuntimeAuth.mockReset();
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  mocks.acquireRuntimeLease.mockResolvedValue({
    snapshot: {
      testGeneration: "A",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/runtime-workspace",
      config: {},
      authModes: {},
      metadataSnapshot: { plugins: [], index: { plugins: [] } },
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      activeProjectKeys: [],
      createStores: () => ({ authStorage, modelRegistry }),
    },
    release: vi.fn(),
  });
});

it("keeps route rematerialization and runtime auth on the acquired generation", async () => {
  const observedModelGenerations: string[] = [];
  const observedRuntimeAuthGenerations: string[] = [];
  const modelResolver: typeof resolveModelAsync = vi.fn(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("prepared stores were not bound");
      }
      const generation = mocks.readGeneration();
      observedModelGenerations.push(generation);
      const configured = cfg?.models?.providers?.openai;
      return {
        model: {
          provider,
          id: modelId,
          name: modelId,
          api: configured?.api ?? "openai-chatgpt-responses",
          baseUrl: configured?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
          params: { generation },
        } satisfies Model,
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
      };
    },
  );
  mocks.getApiKeyForModel.mockImplementation(async () => {
    await Promise.resolve();
    mocks.publishedGeneration = "B";
    return {
      apiKey: "sk-platform",
      profileId: "openai:platform",
      source: "profile:openai:platform",
      mode: "api-key",
    };
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
    observedRuntimeAuthGenerations.push(mocks.readGeneration());
    return undefined;
  });

  const result = await prepareSimpleCompletionModel({
    cfg: {},
    agentId: "main",
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
    modelResolver,
  });

  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
  expect(result.model.params).toMatchObject({ generation: "A" });
  expect(observedModelGenerations).toEqual(["A", "A"]);
  expect(observedRuntimeAuthGenerations).toEqual(["A"]);
});
