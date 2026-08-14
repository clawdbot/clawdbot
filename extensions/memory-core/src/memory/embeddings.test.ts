// Memory Core tests cover embeddings plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderFallbackModel,
  resolveEmbeddingProviderFallbackRemote,
} from "./embeddings.js";

const mockEmbeddingRegistry = vi.hoisted(() => ({
  genericAdapters: [] as EmbeddingProviderAdapter[],
  adapters: [] as MemoryEmbeddingProviderAdapter[],
  genericLookupConfigs: [] as Array<OpenClawConfig | undefined>,
  acquireLocalService: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  DEFAULT_LOCAL_MODEL: "nomic-embed-text",
  createLocalEmbeddingProvider: async () => {
    throw new Error("local embedding provider is not used by these tests");
  },
  getMemoryEmbeddingProvider: (id: string, config?: OpenClawConfig) => {
    const memoryAdapter = mockEmbeddingRegistry.adapters.find((adapter) => adapter.id === id);
    if (memoryAdapter) {
      return memoryAdapter;
    }
    mockEmbeddingRegistry.genericLookupConfigs.push(config);
    const genericAdapter = mockEmbeddingRegistry.genericAdapters.find(
      (adapter) => adapter.id === id,
    );
    if (!genericAdapter) {
      return undefined;
    }
    return {
      ...genericAdapter,
      create: async (options) => {
        const result = await genericAdapter.create({
          ...options,
          ...(typeof options.outputDimensionality === "number"
            ? { dimensions: options.outputDimensionality }
            : {}),
        });
        const provider = result.provider;
        if (!provider) {
          return { ...result, provider: null };
        }
        return {
          ...result,
          provider: {
            ...provider,
            embedQuery: (text, callOptions) =>
              provider.embed(text, { ...callOptions, inputType: "query" }),
            embedBatch: (texts, callOptions) =>
              provider.embedBatch(texts, { ...callOptions, inputType: "document" }),
            ...(provider.close ? { close: () => provider.close?.() } : {}),
          },
        };
      },
    } satisfies MemoryEmbeddingProviderAdapter;
  },
  listMemoryEmbeddingProviders: () => [...mockEmbeddingRegistry.adapters],
  listRegisteredMemoryEmbeddingProviderAdapters: () => [...mockEmbeddingRegistry.adapters],
  listRegisteredMemoryEmbeddingProviders: () =>
    mockEmbeddingRegistry.adapters.map((adapter) => ({ adapter })),
}));

const missingBedrockCredentialsError = new Error(
  'No API key found for provider "bedrock". AWS credentials are not available.',
);

function createOptions(
  provider: string,
  acquireLocalService = mockEmbeddingRegistry.acquireLocalService,
) {
  return {
    config: {
      plugins: {
        deny: [
          "amazon-bedrock",
          "github-copilot",
          "google",
          "lmstudio",
          "memory-core",
          "mistral",
          "ollama",
          "openai",
          "voyage",
        ],
      },
    } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback: "none",
    model: "",
    acquireLocalService,
  };
}

function createMissingCredentialsAdapter(
  overrides: Partial<MemoryEmbeddingProviderAdapter> = {},
): MemoryEmbeddingProviderAdapter {
  return {
    id: "bedrock",
    transport: "remote",
    autoSelectPriority: 60,
    formatSetupError: coerceErrorMessage,
    shouldContinueAutoSelection: (err) =>
      err instanceof Error && err.message.includes("No API key found for provider"),
    create: async () => {
      throw missingBedrockCredentialsError;
    },
    ...overrides,
  };
}

function clearMemoryEmbeddingProviders(): void {
  mockEmbeddingRegistry.genericAdapters = [];
  mockEmbeddingRegistry.adapters = [];
  mockEmbeddingRegistry.genericLookupConfigs = [];
}

function registerGenericEmbeddingProvider(adapter: EmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.genericAdapters = mockEmbeddingRegistry.genericAdapters.filter(
    (candidate) => candidate.id !== adapter.id,
  );
  mockEmbeddingRegistry.genericAdapters.push(adapter);
}

function registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.adapters = mockEmbeddingRegistry.adapters.filter(
    (candidate) => candidate.id !== adapter.id,
  );
  mockEmbeddingRegistry.adapters.push(adapter);
}

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    clearMemoryEmbeddingProviders();
    mockEmbeddingRegistry.acquireLocalService.mockReset();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
  });

  it("normalizes legacy auto mode to OpenAI", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter({ id: "bedrock" }));
    registerMemoryEmbeddingProvider({
      id: "openai",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("openai");
  });

  it("still throws missing credentials for an explicit provider request", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    await expect(createEmbeddingProvider(createOptions("bedrock"))).rejects.toThrow(
      missingBedrockCredentialsError.message,
    );
  });

  it("drops the fallback remote config when it contains only primary-provider fields", () => {
    expect(resolveEmbeddingProviderFallbackRemote(undefined)).toBeUndefined();
    expect(
      resolveEmbeddingProviderFallbackRemote({
        baseUrl: "https://primary-openai.invalid/v1",
        apiKey: "synthetic-primary-openai-api-key",
        headers: { Authorization: "Bearer synthetic-primary-openai-auth" },
      }),
    ).toBeUndefined();
  });

  it("does not retry the primary provider as its own fallback", async () => {
    const create = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => {
      throw new Error("synthetic primary provider unavailable");
    });
    registerMemoryEmbeddingProvider({ id: "openai", create });

    await expect(
      createEmbeddingProvider({ ...createOptions("openai"), fallback: "openai" }),
    ).rejects.toThrow("synthetic primary provider unavailable");

    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["ollama", "lmstudio", "mistral"] as const)(
    "keeps the primary endpoint and credentials out of the %s creation fallback",
    async (fallback) => {
      const primaryCreate = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => {
        throw new Error("synthetic primary provider unavailable");
      });
      const fallbackCreate = vi.fn<MemoryEmbeddingProviderAdapter["create"]>(async () => ({
        provider: {
          id: fallback,
          model: `${fallback}-embedding`,
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }));
      registerMemoryEmbeddingProvider({ id: "openai", create: primaryCreate });
      registerMemoryEmbeddingProvider({ id: fallback, create: fallbackCreate });

      const sharedRemote = {
        nonBatchConcurrency: 3,
        batch: {
          enabled: true,
          wait: false,
          concurrency: 2,
          pollIntervalMs: 250,
          timeoutMinutes: 5,
        },
      };
      const remote = {
        baseUrl: "https://primary-openai.invalid/v1",
        apiKey: "synthetic-primary-openai-api-key",
        headers: {
          Authorization: "Bearer synthetic-primary-openai-auth",
          "X-OpenAI-Secret": "synthetic-primary-openai-header",
        },
        ...sharedRemote,
      };
      const fallbackProviderConfig = {
        baseUrl: `https://${fallback}-provider.invalid/v1`,
        apiKey: "synthetic-fallback-owned-api-key",
        headers: { "X-Fallback-Auth": "synthetic-fallback-owned-header" },
        models: [],
      };
      const primaryOptions = createOptions("openai");
      const config = {
        ...primaryOptions.config,
        models: { providers: { [fallback]: fallbackProviderConfig } },
      } satisfies OpenClawConfig;
      const local = { modelPath: "/tmp/synthetic-memory-model.gguf", contextSize: 2048 };

      const result = await createEmbeddingProvider({
        ...primaryOptions,
        config,
        fallback,
        model: "text-embedding-3-small",
        remote,
        inputType: "passage",
        queryInputType: "query",
        documentInputType: "document",
        outputDimensionality: 768,
        local,
      });

      expect(primaryCreate).toHaveBeenCalledWith(expect.objectContaining({ remote, config }));
      expect(primaryCreate.mock.calls[0]?.[0].remote).toBe(remote);
      expect(fallbackCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: fallback,
          remote: sharedRemote,
          config,
          agentDir: primaryOptions.agentDir,
          acquireLocalService: primaryOptions.acquireLocalService,
          model: "text-embedding-3-small",
          inputType: "passage",
          queryInputType: "query",
          documentInputType: "document",
          outputDimensionality: 768,
          local,
        }),
      );
      expect(fallbackCreate.mock.calls[0]?.[0].remote).toEqual(sharedRemote);
      expect(fallbackCreate.mock.calls[0]?.[0].config.models?.providers?.[fallback]).toEqual(
        fallbackProviderConfig,
      );
      expect(result).toMatchObject({
        requestedProvider: "openai",
        fallbackFrom: "openai",
        provider: { id: fallback },
      });
    },
  );

  it("does not run priority-based auto-selection after a skippable setup failure", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter({ autoSelectPriority: 10 }));
    registerMemoryEmbeddingProvider({
      id: "openai",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("openai");
  });

  it("uses a generic embedding provider when no memory-specific provider exists", async () => {
    const genericProvider = {
      id: "generic",
      model: "generic-model",
      closed: false,
      embed: async (_input: unknown, callOptions?: { inputType?: string }) =>
        callOptions?.inputType === "query" ? [1] : [2],
      embedBatch: async (inputs: unknown[], callOptions?: { inputType?: string }) =>
        inputs.map(() => (callOptions?.inputType === "document" ? [3] : [4])),
      async close() {
        this.closed = true;
      },
    };
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async (options) => {
        expect(
          (
            options as typeof options & {
              acquireLocalService?: typeof mockEmbeddingRegistry.acquireLocalService;
            }
          ).acquireLocalService,
        ).toBe(mockEmbeddingRegistry.acquireLocalService);
        return {
          provider: genericProvider,
        };
      },
    });

    const options = createOptions("openai-compatible");
    const result = await createEmbeddingProvider(options);

    expect(result.provider?.id).toBe("generic");
    expect(mockEmbeddingRegistry.genericLookupConfigs).toEqual([options.config]);
    await expect(result.provider?.embedQuery("hello")).resolves.toEqual([1]);
    await expect(result.provider?.embedBatch(["doc"])).resolves.toEqual([[3]]);
    await result.provider?.close?.();
    expect(genericProvider.closed).toBe(true);
  });

  it("keeps concurrent provider creation bound to each caller's local-service hook", async () => {
    const observedHooks: unknown[] = [];
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async (options) => {
        observedHooks.push(
          (options as typeof options & { acquireLocalService?: unknown }).acquireLocalService,
        );
        await Promise.resolve();
        return {
          provider: {
            id: "generic",
            model: "generic-model",
            embed: async () => [1],
            embedBatch: async (inputs) => inputs.map(() => [1]),
          },
        };
      },
    });
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);

    await Promise.all([
      createEmbeddingProvider(createOptions("openai-compatible", firstAcquire)),
      createEmbeddingProvider(createOptions("openai-compatible", secondAcquire)),
    ]);

    expect(observedHooks).toEqual([firstAcquire, secondAcquire]);
  });

  it("keeps memory-specific providers authoritative during dual registration", async () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "generic",
          model: "generic-model",
          embed: async (_input, options) => (options?.inputType === "query" ? [1] : [2]),
          embedBatch: async (inputs, options) =>
            inputs.map(() => (options?.inputType === "document" ? [3] : [4])),
        },
      }),
    });
    registerMemoryEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "legacy",
          model: "legacy-model",
          embedQuery: async () => [0],
          embedBatch: async (texts) => texts.map(() => [0]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("openai-compatible"));

    expect(result.provider?.id).toBe("legacy");
    await expect(result.provider?.embedQuery("hello")).resolves.toEqual([0]);
  });

  it("reports the llama.cpp plugin install command when local is unregistered", async () => {
    await expect(createEmbeddingProvider(createOptions("local"))).rejects.toThrow(
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });

  it("does not auto-select generic providers by priority policy", async () => {
    registerMemoryEmbeddingProvider({
      id: "openai-compatible",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "legacy",
          model: "legacy-model",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "generic",
          model: "generic-model",
          embed: async () => [2],
          embedBatch: async (inputs) => inputs.map(() => [2]),
        },
      }),
    });

    await expect(createEmbeddingProvider(createOptions("auto"))).rejects.toThrow(
      "Unknown memory embedding provider: openai",
    );
  });

  it("uses config-scoped lookup for generic fallback model resolution", () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      defaultModel: "generic-default",
      create: async () => ({
        provider: null,
      }),
    });
    const options = createOptions("openai-compatible");

    const model = resolveEmbeddingProviderFallbackModel(
      "openai-compatible",
      "source-model",
      options.config,
    );

    expect(model).toBe("generic-default");
    expect(mockEmbeddingRegistry.genericLookupConfigs).toEqual([options.config]);
  });
});
