import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const mocks = vi.hoisted(() => ({
  acquireRuntimeLease: vi.fn(),
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntimeLease,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

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

let generationA = createEmptyPluginRegistry();
let generationB = createEmptyPluginRegistry();

function readGeneration(): string {
  const registry = getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
  return registry === generationA ? "A" : registry === generationB ? "B" : "unscoped";
}

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
  resetPluginRuntimeStateForTest();
  generationA = createEmptyPluginRegistry();
  generationB = createEmptyPluginRegistry();
  setActivePluginRegistry(generationA);
  mocks.acquireRuntimeLease.mockReset();
  mocks.getApiKeyForModel.mockReset();
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.resolvePluginMetadataSnapshot.mockReset().mockImplementation((params) =>
    createPluginMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      manifestRegistry: { plugins: [], diagnostics: [] },
    }),
  );
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  mocks.acquireRuntimeLease.mockImplementation(
    async (
      { config }: { config: OpenClawConfig },
      options?: { pluginMetadataSnapshot?: PluginMetadataSnapshot },
    ) => ({
      snapshot: {
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/runtime-workspace",
        config,
        authModes: {},
        metadataSnapshot:
          options?.pluginMetadataSnapshot ??
          createPluginMetadataSnapshot({
            config,
            workspaceDir: "/tmp/runtime-workspace",
            manifestRegistry: { plugins: [], diagnostics: [] },
          }),
        pluginRegistry: generationA,
        allowGatewaySubagentBinding: false,
        modelCatalog: { entries: [] },
        configuredRuntimeModels: [],
        inlineProviderModels: [],
        activeProjectKeys: [],
        createStores: () => ({ authStorage, modelRegistry }),
      },
      release: vi.fn(),
    }),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setCurrentPluginMetadataSnapshot(undefined);
});

it("keeps route rematerialization and runtime auth on the acquired generation", async () => {
  const observedModelGenerations: string[] = [];
  const observedRuntimeAuthGenerations: string[] = [];
  const modelResolver: typeof resolveModelAsync = vi.fn(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("prepared stores were not bound");
      }
      const generation = readGeneration();
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
    setActivePluginRegistry(generationB);
    return {
      apiKey: "sk-platform",
      profileId: "openai:platform",
      source: "profile:openai:platform",
      mode: "api-key",
    };
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
    observedRuntimeAuthGenerations.push(readGeneration());
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
  expect(readGeneration()).toBe("B");
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
  const manifestRegistry = makeRegistry([
    { id: "selected-provider", channels: [], providers: ["selected-provider"] },
  ]);
  manifestRegistry.plugins[0]!.modelCatalog = {
    providers: {
      "selected-provider": {
        defaultUtilityModel: "utility-model",
        models: [{ id: "primary-model" }, { id: "utility-model" }],
      },
    },
  };
  const metadataSnapshot = createPluginMetadataSnapshot({ manifestRegistry });
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

it.each([
  { raw: "selected-provider/legacy@work", normalizedInput: "legacy", outcome: "model" },
  { raw: "chosen@work", normalizedInput: "legacy", outcome: "model" },
  {
    raw: "selected-provider/selected-provider/selected-provider/legacy@work",
    normalizedInput: "selected-provider/legacy",
    outcome: "model",
  },
  { raw: "chosen@work", normalizedInput: "legacy", outcome: "error" },
])(
  "normalizes only chosen $raw after acquiring its generation ($outcome)",
  async ({ raw, normalizedInput, outcome }) => {
    const workspaceDir = "/tmp/runtime-workspace";
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: workspaceDir } },
        defaults: {
          model: "primary-provider/primary",
          models: {
            "selected-provider/legacy": { alias: "chosen" },
            "unrelated-provider/another-model": { alias: "unused" },
          },
        },
      },
    };
    const manifestRegistry = makeRegistry(
      ["primary-provider", "selected-provider", "unrelated-provider"].map((id) => ({
        id,
        channels: [],
        providers: [id],
      })),
    );
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      workspaceDir,
      manifestRegistry,
    });
    const observed: Array<{
      registry: ReturnType<typeof getPluginRuntimeGenerationRegistry>;
      modelId: string;
    }> = [];
    const selectedNormalizer = vi.fn(({ modelId }: { modelId: string }) => {
      observed.push({ registry: getPluginRuntimeGenerationRegistry(), modelId });
      return modelId === normalizedInput ? "runtime-model" : `renormalized-${modelId}`;
    });
    const primaryNormalizer = vi.fn(({ modelId }: { modelId: string }) => modelId);
    const unrelatedNormalizer = vi.fn(({ modelId }: { modelId: string }) => modelId);
    const ambientNormalizer = vi.fn(() => "ambient-model");
    for (const registry of [generationA, generationB]) {
      for (const manifest of manifestRegistry.plugins) {
        registry.plugins.push(
          createPluginRecord({
            id: manifest.id,
            source: manifest.source,
            rootDir: manifest.rootDir,
            origin: manifest.origin,
            providerIds: manifest.providers,
          }),
        );
        registry.providers.push({
          pluginId: manifest.id,
          source: manifest.source,
          rootDir: manifest.rootDir,
          provider: {
            id: manifest.id,
            label: manifest.id,
            auth: [],
            normalizeModelId:
              registry === generationB
                ? ambientNormalizer
                : manifest.id === "selected-provider"
                  ? selectedNormalizer
                  : manifest.id === "primary-provider"
                    ? primaryNormalizer
                    : unrelatedNormalizer,
          },
        });
      }
    }
    setCurrentPluginMetadataSnapshot(metadataSnapshot, { config, workspaceDir });
    setActivePluginRegistry(generationA, "selection-generation-A", "default", workspaceDir);
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(metadataSnapshot);
    const acquire = mocks.acquireRuntimeLease.getMockImplementation();
    if (!acquire) {
      throw new Error("Expected the generation fixture's acquisition implementation");
    }
    mocks.acquireRuntimeLease.mockImplementation(async (input, options) => {
      const lease = await acquire(input, options);
      setActivePluginRegistry(generationB, "selection-generation-B", "default", workspaceDir);
      return lease;
    });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "fixture-local-marker",
      source: "fixture",
      mode: "api-key",
    });
    const baseResolver = createOllamaModelResolver();
    const modelResolver = vi.fn<typeof resolveModelAsync>(async (...args) => {
      const resolved = await baseResolver(...args);
      return outcome === "error"
        ? {
            error: "fixture model unavailable",
            authStorage: resolved.authStorage,
            modelRegistry: resolved.modelRegistry,
          }
        : resolved;
    });

    const result = await prepareSimpleCompletionModelForAgent({
      cfg: config,
      agentId: "main",
      agentDir: "/tmp/canonical-agent",
      modelRef: raw,
      modelResolver,
    });

    expect(observed).toEqual([{ registry: generationA, modelId: normalizedInput }]);
    expect(primaryNormalizer).not.toHaveBeenCalled();
    expect(unrelatedNormalizer).not.toHaveBeenCalled();
    expect(ambientNormalizer).not.toHaveBeenCalled();
    expect(vi.mocked(modelResolver).mock.calls[0]?.slice(0, 2)).toEqual([
      "selected-provider",
      "runtime-model",
    ]);
    expect(result).toMatchObject({
      selection: {
        provider: "selected-provider",
        modelId: "runtime-model",
        profileId: "work",
        agentDir: "/tmp/canonical-agent",
      },
      ...(outcome === "error"
        ? { error: "fixture model unavailable" }
        : { model: { provider: "selected-provider", id: "runtime-model" } }),
    });
    expect(readGeneration()).toBe("B");
  },
);
