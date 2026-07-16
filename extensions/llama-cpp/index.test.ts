import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  clearMemoryEmbeddingProviders,
  getRegisteredEmbeddingProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const memoryHostEmbeddingMocks = vi.hoisted(() => ({
  createLocalEmbeddingProvider: vi.fn(),
}));
const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  createLocalEmbeddingProvider: memoryHostEmbeddingMocks.createLocalEmbeddingProvider,
}));

import llamaCppPlugin from "./index.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";

const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
type AdapterCreateOptions = Parameters<typeof llamaCppEmbeddingProviderAdapter.create>[0];
type MemoryCreateTestOptions = AdapterCreateOptions & {
  fallback?: "none";
  outputDimensionality?: number;
};

async function createLlamaCppMemoryEmbeddingProvider(options: MemoryCreateTestOptions) {
  const { fallback: _fallback, outputDimensionality, ...adapterOptions } = options;
  return await llamaCppEmbeddingProviderAdapter.create({
    ...adapterOptions,
    dimensions: outputDimensionality,
  });
}

afterEach(() => {
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
  memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockReset();
});

describe("llama.cpp provider plugin", () => {
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
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

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
      os.homedir(),
      ".node-llama-cpp",
      "models",
      "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
    );
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: modelPath,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: modelPath,
      local: { modelPath },
    });

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    });
    expect(result.runtime?.indexIdentityAliases).toEqual([
      {
        model: modelPath,
        cacheKeyData: {
          provider: "local",
          model: modelPath,
        },
      },
      {
        model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
        cacheKeyData: {
          provider: "local",
          model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
        },
      },
    ]);
    expect(
      llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
        config: {},
        provider: "local",
        model: modelPath,
        local: { modelPath },
      }),
    ).toEqual({
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheKeyData: {
        provider: "local",
        model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      },
      aliases: [
        {
          model: modelPath,
          cacheKeyData: {
            provider: "local",
            model: modelPath,
          },
        },
        {
          model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
          cacheKeyData: {
            provider: "local",
            model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
          },
        },
      ],
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

  it("keeps an arbitrary same-basename model path as a distinct identity", async () => {
    const modelPath = path.join(
      os.tmpdir(),
      "custom-models",
      DEFAULT_LLAMA_CPP_EMBEDDING_MODEL.split("/").at(-1)!,
    );
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: modelPath,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: modelPath,
      local: { modelPath },
    });

    expect(result.provider?.model).toBe(modelPath);
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: modelPath,
    });
    expect(result.runtime).not.toHaveProperty("indexIdentityAliases");
  });

  it("keeps a bare same-basename file in the default cache as a distinct identity", async () => {
    const modelPath = path.join(
      os.homedir(),
      ".node-llama-cpp",
      "models",
      DEFAULT_LLAMA_CPP_EMBEDDING_MODEL.split("/").at(-1)!,
    );
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: modelPath,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: modelPath,
      local: { modelPath },
    });

    expect(result.provider?.model).toBe(modelPath);
    expect(result.runtime).not.toHaveProperty("indexIdentityAliases");
  });

  it("keeps the default model identity with a custom cache directory", async () => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-model-cache");
    const modelPath = path.join(modelCacheDir, "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf");
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: modelPath,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      local: { modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, modelCacheDir },
    });

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    });
    expect(result.runtime?.indexIdentityAliases).toEqual([
      {
        model: modelPath,
        cacheKeyData: {
          provider: "local",
          model: modelPath,
        },
      },
      {
        model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
        cacheKeyData: {
          provider: "local",
          model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
        },
      },
    ]);
  });

  it.each([
    {
      direction: "default URI to exact relative cache artifact",
      modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    },
    {
      direction: "exact relative cache artifact to default URI",
      modelPath: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
    },
  ])("keeps $direction compatible", ({ modelPath }) => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-relative-model-cache");
    const relativeModelPath = "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf";
    const resolvedModelPath = path.join(modelCacheDir, relativeModelPath);

    expect(
      llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
        config: {},
        provider: "local",
        model: modelPath,
        local: { modelPath, modelCacheDir },
      }),
    ).toEqual({
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheKeyData: {
        provider: "local",
        model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      },
      aliases: [
        {
          model: resolvedModelPath,
          cacheKeyData: {
            provider: "local",
            model: resolvedModelPath,
          },
        },
        {
          model: relativeModelPath,
          cacheKeyData: {
            provider: "local",
            model: relativeModelPath,
          },
        },
      ],
    });
  });

  it("keeps the default model identity for its exact relative cache artifact", async () => {
    const modelCacheDir = path.join(os.tmpdir(), "llama-cpp-relative-model-cache");
    const modelPath = "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf";
    const resolvedModelPath = path.join(modelCacheDir, modelPath);
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: modelPath,
      embedQuery: vi.fn(),
      embedBatch: vi.fn(),
    });

    const result = await createLlamaCppMemoryEmbeddingProvider({
      config: {},
      provider: "local",
      fallback: "none",
      model: modelPath,
      local: { modelPath, modelCacheDir },
    });

    expect(result.provider?.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(result.runtime?.indexIdentityAliases).toEqual([
      {
        model: resolvedModelPath,
        cacheKeyData: {
          provider: "local",
          model: resolvedModelPath,
        },
      },
      {
        model: modelPath,
        cacheKeyData: {
          provider: "local",
          model: modelPath,
        },
      },
    ]);
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
