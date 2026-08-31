import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const mocks = vi.hoisted(() => ({
  acquireRuntimeLease: vi.fn(),
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  publishedGeneration: "A",
  readGeneration: (() => "unscoped") as () => string,
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntimeLease,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
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

import {
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

function createOllamaModelResolver(): typeof resolveModelAsync {
  return vi.fn(async (provider, modelId, _agentDir, _cfg, options) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model,
    authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
    modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
  }));
}

beforeEach(() => {
  mocks.publishedGeneration = "A";
  mocks.acquireRuntimeLease.mockReset();
  mocks.getApiKeyForModel.mockReset();
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.resolvePluginMetadataSnapshot
    .mockReset()
    .mockReturnValue(createPluginMetadataSnapshotFixture());
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  mocks.acquireRuntimeLease.mockResolvedValue({
    snapshot: {
      testGeneration: "A",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/runtime-workspace",
      config: {},
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
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

it("acquires direct completion runtime for the exact selected model", async () => {
  const modelResolver = createOllamaModelResolver();
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  await prepareSimpleCompletionModel({
    cfg: {},
    agentId: "main",
    provider: "ollama",
    modelId: "qwen3:0.6b",
    agentDir: "/tmp/openclaw-agent",
    agentRuntimeId: "openclaw",
    modelResolver,
  });

  expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimePluginSelections: [
        {
          provider: "ollama",
          modelId: "qwen3:0.6b",
          runtime: "openclaw",
          agentId: "main",
        },
      ],
    }),
    expect.objectContaining({ catalogMode: "static" }),
  );
  expect(modelResolver).toHaveBeenCalledOnce();
});

it("selects an explicit agent completion model before runtime acquisition", async () => {
  const modelResolver = createOllamaModelResolver();
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  await prepareSimpleCompletionModelForAgent({
    cfg: {},
    agentId: "main",
    modelRef: "ollama/qwen3:0.6b",
    modelResolver,
  });

  expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimePluginSelections: [{ provider: "ollama", modelId: "qwen3:0.6b", agentId: "main" }],
    }),
    expect.objectContaining({ catalogMode: "static" }),
  );
  expect(modelResolver).toHaveBeenCalledOnce();
});

it("acquires the canonical manifest-derived utility model selection", async () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "selected-provider",
        modelCatalog: {
          providers: {
            "selected-provider": {
              defaultUtilityModel: "utility-model",
              models: [{ id: "primary-model" }, { id: "utility-model" }],
            },
          },
        },
      },
    ],
  });
  mocks.resolvePluginMetadataSnapshot.mockReturnValue(metadataSnapshot);

  const result = await prepareSimpleCompletionModelForAgent({
    cfg: {
      agents: { defaults: { model: "selected-provider/primary-model@work" } },
    },
    agentId: "main",
    agentDir: "/tmp/canonical-agent",
    useUtilityModel: true,
    modelResolver: vi.fn(async (_provider, _modelId, _agentDir, _cfg, options) => ({
      error: "stop after canonical selection",
      authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
      modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
    })),
  });

  expect(
    mocks.resolvePluginMetadataSnapshot.mock.calls.filter(
      ([params]) => (params as { pluginIdScope?: unknown } | undefined)?.pluginIdScope,
    ),
  ).toHaveLength(2);
  expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimePluginSelections: [
        { provider: "selected-provider", modelId: "utility-model", agentId: "main" },
      ],
      agentDir: "/tmp/canonical-agent",
    }),
    expect.objectContaining({ catalogMode: "static", pluginMetadataSnapshot: metadataSnapshot }),
  );
  expect(result).toMatchObject({
    selection: {
      provider: "selected-provider",
      modelId: "utility-model",
      profileId: "work",
      agentDir: "/tmp/canonical-agent",
    },
  });
});
