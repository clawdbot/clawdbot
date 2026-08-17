import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createLocalEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getRegisteredEmbeddingProvider,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  prepareServer: vi.fn(),
  inspectRuntime: vi.fn(),
  genericCreate: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/embedding-providers")>()),
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));

vi.mock("./src/managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
  inspectLlamaServerRuntime: mocks.inspectRuntime,
}));

import llamaCppPlugin from "./index.js";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
} from "./src/defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

beforeEach(() => {
  previousPluginRegistry = getActivePluginRegistry();
  mocks.ensureModel.mockResolvedValue("/models/model.gguf");
  mocks.prepareServer.mockResolvedValue({});
  mocks.inspectRuntime.mockResolvedValue({
    engine: "llama.cpp",
    state: "ready",
    buildInfo: "b10357 (689e227db)",
    model: { id: "embeddinggemma-300m-qat-q8_0", path: "/models/embedding.gguf" },
    capabilities: { vision: false, draft: false },
    endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
  });
  mocks.genericCreate.mockResolvedValue({
    provider: {
      id: "openai-compatible",
      model: "embeddinggemma-300m-qat-q8_0",
      embed: vi.fn(async () => [0.6, 0.8]),
      embedBatch: vi.fn(async () => [[0.3, 0.4]]),
    },
    runtime: { id: "openai-compatible" },
  });
});

afterEach(() => {
  clearEmbeddingProviders();
  clearEmbeddingProviders();
  setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
  vi.clearAllMocks();
});

function registerTextProvider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  llamaCppPlugin.register(
    createTestPluginApi({
      id: LLAMA_CPP_PROVIDER_ID,
      name: "llama.cpp Provider",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerProvider: (provider) => providers.push(provider),
    }),
  );
  return expectDefined(providers[0], "llama.cpp provider");
}

function configuredOptions() {
  return {
    config: {
      models: {
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: {
            api: "openai-completions" as const,
            apiKey: "llama-cpp-local",
            baseUrl: "http://127.0.0.1:19432/v1",
            localService: {
              command: "/runtime/llama-server",
              args: ["--models-preset", "/runtime/models.ini"],
              healthUrl: "http://127.0.0.1:19432/health",
            },
            models: [
              {
                id: "gemma-4-e4b-it-q4_k_m",
                name: "Gemma 4 E4B",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 2048,
                params: { modelPath: "/models/chat.gguf" },
              },
            ],
          },
        },
      },
    },
    provider: "local",
    model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  };
}

describe("llama.cpp provider plugin", () => {
  it("keeps pre-managed installed provider imports loadable without reviving the old runtime", async () => {
    await expect(createLocalEmbeddingProvider({}, {})).rejects.toThrow(
      "The legacy in-process llama.cpp embedding runtime is retired",
    );
    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("uses the normal OpenAI-compatible text transport", () => {
    expect(registerTextProvider()).toEqual(
      expect.objectContaining({
        id: LLAMA_CPP_PROVIDER_ID,
        label: "llama.cpp",
        normalizeToolSchemas: expect.any(Function),
        inspectToolSchemas: expect.any(Function),
        auth: [expect.objectContaining({ id: "local" })],
      }),
    );
    expect(registerTextProvider()).not.toHaveProperty("createStreamFn");
  });

  it("registers local embeddings through the generic provider contract", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: LLAMA_CPP_PROVIDER_ID,
      name: "llama.cpp Provider",
      contracts: { embeddingProviders: ["local"] },
      register: llamaCppPlugin.register,
    });
    setActivePluginRegistry(registry.registry);

    expect(getRegisteredEmbeddingProvider("local")).toMatchObject({
      ownerPluginId: LLAMA_CPP_PROVIDER_ID,
      adapter: {
        id: "local",
        defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        transport: "local",
      },
    });
  });

  it("requires managed setup when local memory retains a remote SecretRef", async () => {
    await expect(
      llamaCppEmbeddingProviderAdapter.create({
        config: {
          memory: {
            search: {
              provider: "local",
              remote: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
        provider: "local",
        model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      }),
    ).rejects.toThrow("Local embeddings need the managed llama.cpp server config");
    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("routes embeddings through the managed server and reports endpoint facts", async () => {
    const result = await llamaCppEmbeddingProviderAdapter.create(configuredOptions());
    const provider = expectDefined(result.provider, "local embedding provider");

    await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
    expect(mocks.genericCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: LLAMA_CPP_PROVIDER_ID,
        model: "embeddinggemma-300m-qat-q8_0",
        remote: undefined,
      }),
    );
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    });
    const readFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
    expect(typeof readFacts).toBe("function");
    expect(readFacts()).toMatchObject({
      buildInfo: "b10357 (689e227db)",
      endpoints: { health: "ready", metrics: "ready" },
    });
  });

  it("routes embeddings without requiring a configured chat model", async () => {
    const options = {
      ...configuredOptions(),
      local: { modelPath: "/models/custom-embedding.gguf" },
    };
    const provider = options.config.models.providers[LLAMA_CPP_PROVIDER_ID];
    provider.models = [];

    const result = await llamaCppEmbeddingProviderAdapter.create(options);

    expect(mocks.ensureModel).toHaveBeenCalledTimes(1);
    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "/models/custom-embedding.gguf",
        download: true,
      }),
    );
    expect(mocks.prepareServer).toHaveBeenCalledWith(
      expect.objectContaining({
        chatModelPath: undefined,
        embeddingModelPath: "/models/model.gguf",
      }),
    );
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: "/models/custom-embedding.gguf",
    });
  });

  it("preserves default local index identity across old and managed cache paths", () => {
    const modelCacheDir = path.join(os.tmpdir(), "managed-llama-models");
    const identity = llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
      config: {},
      provider: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      local: { modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, modelCacheDir },
    });

    expect(identity).toMatchObject({
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      cacheKeyData: { provider: "local", model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL },
    });
    expect(identity?.aliases?.map((entry) => entry.model)).toEqual(
      expect.arrayContaining([
        path.join(modelCacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
        path.join(resolveLegacyLlamaCppModelCacheDir(), DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
        DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
      ]),
    );
  });

  it("keeps custom GGUF identities literal", () => {
    expect(
      llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
        config: {},
        provider: "local",
        model: "/models/custom.gguf",
        local: { modelPath: "/models/custom.gguf" },
        dimensions: 512,
      }),
    ).toEqual({
      model: "/models/custom.gguf",
      cacheKeyData: {
        provider: "local",
        model: "/models/custom.gguf",
        outputDimensionality: 512,
      },
      aliases: [],
    });
  });
});
