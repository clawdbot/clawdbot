import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  clearMemoryEmbeddingProviders,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getRegisteredEmbeddingProvider,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memoryHostEmbeddingMocks = vi.hoisted(() => ({
  createLocalEmbeddingProvider: vi.fn(),
}));
const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  createLocalEmbeddingProvider: memoryHostEmbeddingMocks.createLocalEmbeddingProvider,
}));

import llamaCppPlugin from "./index.js";
import { LLAMA_CPP_LOCAL_BASE_URL } from "./src/defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";

const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE = "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_DIR = path.join(os.homedir(), ".node-llama-cpp", "models");
type AdapterCreateOptions = Parameters<typeof llamaCppEmbeddingProviderAdapter.create>[0];
type MemoryCreateTestOptions = AdapterCreateOptions & {
  fallback?: "none";
  outputDimensionality?: number;
};
let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

beforeEach(() => {
  previousPluginRegistry = getActivePluginRegistry();
});

function registerLlamaCppTextProvider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  llamaCppPlugin.register(
    createTestPluginApi({
      id: "llama-cpp",
      name: "llama.cpp Provider",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerProvider: (provider) => providers.push(provider),
    }),
  );
  return expectDefined(providers[0], "llama.cpp text provider");
}

async function createLlamaCppMemoryEmbeddingProvider(options: MemoryCreateTestOptions) {
  const { fallback: _fallback, outputDimensionality, ...adapterOptions } = options;
  return await llamaCppEmbeddingProviderAdapter.create({
    ...adapterOptions,
    dimensions: outputDimensionality,
  });
}

function mockLocalEmbeddingProvider(model = DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
  memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
    id: "local",
    model,
    embedQuery: vi.fn(),
    embedBatch: vi.fn(),
  });
}

async function createMemoryProvider(
  model: string,
  local: NonNullable<AdapterCreateOptions["local"]> = { modelPath: model },
) {
  return await createLlamaCppMemoryEmbeddingProvider({
    config: {},
    provider: "local",
    fallback: "none",
    model,
    local,
  });
}

function cacheKeyData(model = DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
  return { provider: "local", model };
}

function identityAliases(...models: string[]) {
  return models.map((model) => ({ model, cacheKeyData: cacheKeyData(model) }));
}

function resolveIndexIdentity(modelPath: string, modelCacheDir?: string) {
  return llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
    config: {},
    provider: "local",
    model: modelPath,
    local: { modelPath, ...(modelCacheDir ? { modelCacheDir } : {}) },
  });
}

afterEach(() => {
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
  setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
  memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockReset();
});

describe("llama.cpp provider plugin", () => {
  it("registers the local text-inference provider", () => {
    expect(registerLlamaCppTextProvider()).toEqual(
      expect.objectContaining({
        id: "llama-cpp",
        label: "llama.cpp",
        createStreamFn: expect.any(Function),
        normalizeToolSchemas: expect.any(Function),
        inspectToolSchemas: expect.any(Function),
        auth: [expect.objectContaining({ id: "local" })],
      }),
    );
  });

  it("keeps explicit HTTP routes on the configured transport", () => {
    const provider = registerLlamaCppTextProvider();
    const createStream = (baseUrl: string) =>
      provider.createStreamFn?.({
        config: {
          models: {
            providers: {
              "llama-cpp": {
                api: "openai-completions",
                baseUrl,
                models: [],
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          baseUrl,
          id: "local-model",
          provider: "llama-cpp",
        },
        modelId: "local-model",
        provider: "llama-cpp",
      } as never);

    expect(createStream("http://127.0.0.1:8080/v1")).toBeUndefined();
    expect(createStream(LLAMA_CPP_LOCAL_BASE_URL)).toBeTypeOf("function");
  });

  it("registers the local embedding provider through the generic SDK contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "llama-cpp",
      name: "llama.cpp Provider",
      contracts: {
        embeddingProviders: ["local"],
      },
      register: llamaCppPlugin.register,
    });
    setActivePluginRegistry(registry.registry);

    const provider = getRegisteredEmbeddingProvider("local");
    expect(provider?.ownerPluginId).toBe("llama-cpp");
    expect(provider?.adapter).toMatchObject({
      id: "local",
      defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      transport: "local",
    });
  });

  it("adapts the worker-backed local embedding provider", async () => {
    const close = vi.fn();
    const getRuntimeFacts = vi.fn(() => ({
      engine: "llama.cpp" as const,
      state: "ready" as const,
      backend: "metal" as const,
      buildType: "prebuilt" as const,
    }));
    const workerProvider = {
      id: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      maxInputTokens: 2048,
      embedQuery: vi.fn(async () => [0.6, 0.8]),
      embedBatchInputs: vi.fn(async () => [[0.3, 0.4]]),
      embedBatch: vi.fn(async () => [[1, 0]]),
      close,
    };
    Object.defineProperty(workerProvider, LOCAL_EMBEDDING_RUNTIME_FACTS, {
      value: getRuntimeFacts,
    });
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue(workerProvider);
    const abortController = new AbortController();

    const result = await llamaCppEmbeddingProviderAdapter.create({
      config: {},
      provider: "local",
      model: "text-embedding-3-small",
    });
    const provider = result.provider;
    expect(provider).not.toBeNull();
    if (!provider) {
      throw new Error("expected llama.cpp provider");
    }

    await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
    await expect(
      provider.embedBatch([{ text: "doc" }], { signal: abortController.signal }),
    ).resolves.toEqual([[0.3, 0.4]]);
    await provider.close?.();

    expect(provider.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(provider.maxInputTokens).toBe(2048);
    const adaptedGetRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
    if (typeof adaptedGetRuntimeFacts !== "function") {
      throw new Error("expected llama.cpp runtime facts carrier");
    }
    expect(adaptedGetRuntimeFacts()).toEqual({
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      buildType: "prebuilt",
    });
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(memoryHostEmbeddingMocks.createLocalEmbeddingProvider).toHaveBeenCalledWith(
      {
        config: {},
        provider: "local",
        fallback: "none",
        model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        local: {
          modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        },
      },
      {
        nodeLlamaCppImportUrl: expect.stringContaining("node-llama-cpp"),
      },
    );
    const mockResult = expectDefined(
      memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mock.results[0],
      "llama.cpp embedding provider result",
    );
    const createdWorkerProvider = await mockResult.value;
    expect(createdWorkerProvider.embedBatchInputs).toHaveBeenCalledWith([{ text: "doc" }], {
      signal: abortController.signal,
    });
  });

  it("includes output dimensionality in local cache and index identities", async () => {
    mockLocalEmbeddingProvider();

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      outputDimensionality: 512,
    });
    const resolvedIdentity = llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
      config: {},
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      dimensions: 512,
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({ outputDimensionality: 512 });
    expect(result.runtime?.indexIdentityAliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cacheKeyData: expect.objectContaining({ outputDimensionality: 512 }),
        }),
      ]),
    );
    expect(resolvedIdentity?.cacheKeyData).toMatchObject({ outputDimensionality: 512 });
    expect(resolvedIdentity?.aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cacheKeyData: expect.objectContaining({ outputDimensionality: 512 }),
        }),
      ]),
    );
  });

  it("keeps the default model identity when configured with its exact cache artifact path", async () => {
    const modelPath = path.join(
      DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_DIR,
      DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
    );
    mockLocalEmbeddingProvider(modelPath);

    const result = await createMemoryProvider(modelPath);

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toEqual(cacheKeyData());
    expect(result.runtime?.indexIdentityAliases).toEqual(
      identityAliases(modelPath, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    );
    expect(resolveIndexIdentity(modelPath)).toEqual({
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheKeyData: cacheKeyData(),
      aliases: identityAliases(modelPath, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    });
    expect(memoryHostEmbeddingMocks.createLocalEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        model: modelPath,
        local: { modelPath },
      }),
      {
        nodeLlamaCppImportUrl: expect.stringContaining("node-llama-cpp"),
      },
    );
  });

  it.each([
    [
      "keeps an arbitrary same-basename model path as a distinct identity",
      path.join(os.tmpdir(), "custom-models", DEFAULT_LLAMA_CPP_EMBEDDING_MODEL.split("/").at(-1)!),
      true,
    ],
    [
      "keeps a bare same-basename file in the default cache as a distinct identity",
      path.join(
        DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_DIR,
        DEFAULT_LLAMA_CPP_EMBEDDING_MODEL.split("/").at(-1)!,
      ),
      false,
    ],
  ])("%s", async (_name, modelPath, checksCacheKey) => {
    mockLocalEmbeddingProvider(modelPath);
    const result = await createMemoryProvider(modelPath);

    expect(result.provider?.model).toBe(modelPath);
    if (checksCacheKey) {
      expect(result.runtime?.cacheKeyData).toEqual(cacheKeyData(modelPath));
    }
    expect(result.runtime).not.toHaveProperty("indexIdentityAliases");
  });

  it("keeps the default model identity with a custom cache directory", async () => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-model-cache");
    const modelPath = path.join(modelCacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE);
    mockLocalEmbeddingProvider(modelPath);

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      local: { modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, modelCacheDir },
    });

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toEqual(cacheKeyData());
    expect(result.runtime?.indexIdentityAliases).toEqual(
      identityAliases(modelPath, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    );
  });

  it.each([
    {
      direction: "default URI to exact relative cache artifact",
      modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    },
    {
      direction: "exact relative cache artifact to default URI",
      modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
    },
  ])("keeps $direction compatible", ({ modelPath }) => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-relative-model-cache");
    const relativeModelPath = DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE;
    const resolvedModelPath = path.join(modelCacheDir, relativeModelPath);

    expect(resolveIndexIdentity(modelPath, modelCacheDir)).toEqual({
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheKeyData: cacheKeyData(),
      aliases: identityAliases(resolvedModelPath, relativeModelPath),
    });
  });

  it("keeps the default model identity for its exact relative cache artifact", async () => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-relative-model-cache");
    const modelPath = DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE;
    const resolvedModelPath = path.join(modelCacheDir, modelPath);
    mockLocalEmbeddingProvider(modelPath);

    const result = await createMemoryProvider(modelPath, { modelPath, modelCacheDir });

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.indexIdentityAliases).toEqual(
      identityAliases(resolvedModelPath, modelPath),
    );
  });

  it("formats missing runtime errors with the plugin install command", () => {
    const err = Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    expect(llamaCppEmbeddingProviderAdapter.formatSetupError?.(err)).toContain(
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });
});
