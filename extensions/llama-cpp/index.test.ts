import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
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
  discoverServer: vi.fn(),
  ensureModel: vi.fn(),
  ensureChat: vi.fn(),
  prepareServer: vi.fn(),
  inspectRuntime: vi.fn(),
  genericCreate: vi.fn(),
  detectHardware: vi.fn(),
}));

vi.mock("./src/hardware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/hardware.js")>()),
  detectLlamaCppHardware: mocks.detectHardware,
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/embedding-providers")>()),
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));

vi.mock("./src/managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  ensureManagedLlamaServerForChat: mocks.ensureChat,
  prepareManagedLlamaServer: mocks.prepareServer,
  inspectLlamaServerRuntime: mocks.inspectRuntime,
}));

vi.mock("./src/external-server/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/external-server/discovery.js")>()),
  discoverLlamaServer: mocks.discoverServer,
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
  mocks.detectHardware.mockReset();
  mocks.discoverServer.mockReset();
  mocks.ensureModel.mockResolvedValue("/models/model.gguf");
  mocks.ensureChat.mockResolvedValue(undefined);
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
  setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
  vi.clearAllMocks();
});

function captureTextRegistration(): { providers: ProviderPlugin[] } {
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
  return { providers };
}

function registerTextProvider(): ProviderPlugin {
  return expectDefined(
    captureTextRegistration().providers.find((provider) => provider.id === LLAMA_CPP_PROVIDER_ID),
    "llama.cpp provider",
  );
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
    const { providers } = captureTextRegistration();
    const provider = expectDefined(providers[0], "llama.cpp provider");

    expect(providers.map((registered) => registered.id)).toEqual([LLAMA_CPP_PROVIDER_ID]);
    expect(provider).toEqual(
      expect.objectContaining({
        id: LLAMA_CPP_PROVIDER_ID,
        label: "llama.cpp",
        normalizeToolSchemas: expect.any(Function),
        inspectToolSchemas: expect.any(Function),
        auth: expect.arrayContaining([
          expect.objectContaining({ id: "local" }),
          expect.objectContaining({ id: "existing-server" }),
        ]),
      }),
    );
    expect(provider.auth.map((method) => method.id)).toEqual(["local", "existing-server"]);
    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual([
      "llama-cpp",
      "llama-cpp-existing-server",
    ]);
    expect(provider).not.toHaveProperty("createStreamFn");
  });

  it("never discovers external models for a managed local service", async () => {
    const provider = registerTextProvider();
    const prepareDynamicModel = expectDefined(provider.prepareDynamicModel, "dynamic model hook");
    const { config } = configuredOptions();

    await expect(
      prepareDynamicModel({
        config,
        provider: LLAMA_CPP_PROVIDER_ID,
        modelId: "gemma-4-e4b-it-q4_k_m",
        modelRegistry: {} as never,
        providerConfig: config.models.providers[LLAMA_CPP_PROVIDER_ID],
      }),
    ).resolves.toBeUndefined();
    expect(mocks.discoverServer).not.toHaveBeenCalled();
  });

  it.each([false, true])("honors thinking off for managed=%s requests", async (managed) => {
    const provider = registerTextProvider();
    const { config } = configuredOptions();
    const configured = config.models.providers[LLAMA_CPP_PROVIDER_ID];
    const model = { ...configured.models[0], provider: LLAMA_CPP_PROVIDER_ID };
    const payload = { chat_template_kwargs: { enable_thinking: true } };
    const inner = vi.fn<StreamFn>(async (requestModel, _context, options) => {
      await options?.onPayload?.(payload, requestModel);
      return {} as never;
    });
    const wrapped = expectDefined(
      provider.wrapStreamFn?.({
        config: managed ? config : {},
        provider: LLAMA_CPP_PROVIDER_ID,
        modelId: model.id,
        model,
        thinkingLevel: "off",
        streamFn: inner,
      } as never),
      "llama.cpp stream wrapper",
    );

    await wrapped(model as never, { messages: [] }, {});

    expect(payload.chat_template_kwargs.enable_thinking).toBe(false);
    expect(mocks.ensureChat).toHaveBeenCalledTimes(managed ? 1 : 0);
  });

  it("keeps an embedding-only managed model inventory empty", async () => {
    const provider = registerTextProvider();
    const catalog = expectDefined(provider.catalog, "managed model catalog");
    const options = configuredOptions();
    options.config.models.providers[LLAMA_CPP_PROVIDER_ID].models = [];

    const result = await catalog.run({
      config: options.config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("managed catalog returned no provider");
    }
    expect(result.provider.models).toEqual([]);
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
        chatModel: { mode: "preserve" },
        embeddingModelPath: "/models/model.gguf",
      }),
    );
    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "local",
      model: "/models/custom-embedding.gguf",
    });
  });

  it.each([
    ["uses an active custom local model", { enabled: true, provider: "local" }],
    ["uses another memory provider", { enabled: true, provider: "openai" }],
    ["has memory search disabled", { enabled: false, provider: "local" }],
  ] as const)(
    "keeps chat preparation independent from embedding config when memory %s",
    async (_label, searchConfig) => {
      const staleEmbeddingSource = "hf:retired-org/removed-embedding-model-GGUF/embedding.gguf";
      const configured = configuredOptions();
      const providerConfig = configured.config.models.providers[LLAMA_CPP_PROVIDER_ID];
      const config = {
        ...configured.config,
        memory: {
          search: {
            ...searchConfig,
            local: { modelPath: staleEmbeddingSource },
          },
        },
      };
      const provider = registerTextProvider();
      const selectedModel = expectDefined(providerConfig.models[0], "managed chat model");
      const inner = vi.fn(() => ({}) as never);
      const wrapped = provider.wrapStreamFn?.({
        config,
        provider: LLAMA_CPP_PROVIDER_ID,
        modelId: selectedModel.id,
        model: {
          ...selectedModel,
          provider: LLAMA_CPP_PROVIDER_ID,
          baseUrl: providerConfig.baseUrl,
        },
        streamFn: inner,
      } as never);

      await wrapped?.({} as never, { messages: [] } as never, {});

      expect(mocks.ensureChat).toHaveBeenCalledWith({
        provider: providerConfig,
        model: expect.objectContaining({ id: selectedModel.id }),
      });
      expect(inner).toHaveBeenCalledOnce();
    },
  );

  it("keeps registered text setup chat-capable when local memory is enabled", async () => {
    const provider = registerTextProvider();
    const method = expectDefined(provider.auth[0], "llama.cpp setup method");
    const options = configuredOptions();
    options.config.models.providers[LLAMA_CPP_PROVIDER_ID].models = [];
    const config = {
      ...options.config,
      memory: {
        search: {
          provider: "local" as const,
        },
      },
    };
    mocks.detectHardware.mockResolvedValue({
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 16 * 1024 ** 3,
      availableDiskBytes: 100 * 1024 ** 3,
      availableRuntimeDiskBytes: 100 * 1024 ** 3,
      sharedDisk: true,
      accelerator: { kind: "cpu", reason: "CPU fixture" },
    });
    mocks.ensureModel.mockImplementation(async ({ source, download }) => {
      if (!download) {
        throw new Error("not cached");
      }
      return source.includes("Qwen3.5-9B-GGUF") ? "/models/chat.gguf" : "/models/embedding.gguf";
    });

    const result = await method.run({
      config,
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
      runtime: {},
    } as never);

    expect(result.defaultModel).toBe(`${LLAMA_CPP_PROVIDER_ID}/qwen3.5-9b-q4_k_m`);
    expect(mocks.prepareServer).toHaveBeenCalledWith(
      expect.objectContaining({
        chatModel: expect.objectContaining({
          mode: "configure",
          id: "qwen3.5-9b-q4_k_m",
          path: "/models/chat.gguf",
        }),
        embeddingModelPath: "/models/embedding.gguf",
      }),
    );
  });

  it("preserves default local index identity across old and managed cache paths", () => {
    const modelCacheDir = path.join(os.tmpdir(), "managed-llama-models");
    const options = configuredOptions();
    Object.assign(options.config.models.providers[LLAMA_CPP_PROVIDER_ID], {
      params: { modelCacheDir },
    });
    const identity = llamaCppEmbeddingProviderAdapter.resolveIndexIdentity?.({
      ...options,
      local: {
        modelPath: path.join(modelCacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
      },
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
