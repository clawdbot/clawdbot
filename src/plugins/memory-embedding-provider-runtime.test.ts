// Covers memory embedding provider runtime hooks from plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmbeddingBatchOptions,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import {
  adaptMemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders
  >(() => []),
  resolvePluginCapabilityProvider: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider
  >(() => undefined),
}));

vi.mock("./capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: mocks.resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders: mocks.resolvePluginCapabilityProviders,
}));

let runtimeModule: typeof import("./memory-embedding-provider-runtime.js");

function createCapabilityAdapter(id: string): EmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(async () => {
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  runtimeModule = await import("./memory-embedding-provider-runtime.js");
});

afterEach(() => {
  clearEmbeddingProviders();
});

describe("memory embedding provider runtime resolution", () => {
  it("merges registered and declared capability fallback adapters", () => {
    registerEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "registered",
      "capability",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("registered")?.id).toBe("registered");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "ollama",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama",
      cfg: undefined,
    });
  });

  it("uses a configured provider api as the memory adapter owner", () => {
    const ollamaAdapter = createCapabilityAdapter("ollama");
    const config = {
      models: {
        providers: {
          "ollama-5080": {
            api: "ollama",
            baseUrl: "http://10.0.0.8:11435",
            models: [],
          },
        },
      },
    };
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "ollama" ? ollamaAdapter : undefined,
    );

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-5080", config as never)?.id).toBe(
      ollamaAdapter.id,
    );
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama-5080",
      cfg: config,
    });
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama",
      cfg: config,
    });
  });

  it("uses registered adapters through a configured provider api", () => {
    const ollamaAdapter = createCapabilityAdapter("ollama");
    registerEmbeddingProvider(ollamaAdapter);
    const config = {
      models: {
        providers: {
          "ollama-gpu1": {
            api: "ollama",
            baseUrl: "http://ollama-host:11435",
            models: [],
          },
        },
      },
    } as never;

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-gpu1", config)?.id).toBe(
      ollamaAdapter.id,
    );
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama-gpu1",
      cfg: config,
    });
  });

  it("prefers registered adapters over declared capability fallback adapters with the same id", () => {
    const registered = {
      id: "openai",
      create: async () => ({ provider: null }),
    } satisfies EmbeddingProviderAdapter;
    registerEmbeddingProvider({
      ...registered,
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("openai")]);

    expect(runtimeModule.getMemoryEmbeddingProvider("openai")?.id).toBe(registered.id);
    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "openai",
    ]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("adapts generic providers for memory queries, batches, and identity", async () => {
    const close = vi.fn();
    const embed = vi.fn(async () => [1, 2]);
    const embedBatch = vi.fn(async (inputs: unknown[]) => inputs.map(() => [3, 4]));
    const batchEmbed = vi.fn(async (options: EmbeddingBatchOptions) =>
      options.chunks.map(() => [5, 6]),
    );
    const runtime = {
      id: "generic",
      inlineQueryTimeoutMs: 1234,
      sourceWideBatchEmbed: true,
      batchEmbed,
    } satisfies EmbeddingProviderRuntime;
    const runtimeFactsKey = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
    const provider = {
      id: "generic",
      model: "generic-model",
      maxInputTokens: 2048,
      embed,
      embedBatch,
      close,
    };
    const runtimeFacts = () => ({ model: "generic-model" });
    Object.defineProperty(provider, runtimeFactsKey, { value: runtimeFacts });
    const create = vi.fn(async () => ({ provider, runtime }));
    registerEmbeddingProvider({
      id: "generic",
      defaultModel: "generic-default",
      transport: "local",
      resolveIndexIdentity: (options) => ({
        model: options.model,
        cacheKeyData: { dimensions: options.dimensions },
      }),
      create,
    });

    const adapter = runtimeModule.getMemoryEmbeddingProvider("generic");
    expect(adapter).toMatchObject({
      id: "generic",
      defaultModel: "generic-default",
      transport: "local",
    });
    expect(runtimeModule.listMemoryEmbeddingProviders().map((entry) => entry.id)).toContain(
      "generic",
    );
    const options = { config: {}, model: "generic-model", outputDimensionality: 7 };
    expect(adapter?.resolveIndexIdentity?.(options)).toEqual({
      model: "generic-model",
      cacheKeyData: { dimensions: 7 },
    });

    const result = await adapter?.create(options);
    expect(create).toHaveBeenCalledWith({ ...options, dimensions: 7 });
    expect(result?.runtime).toBe(runtime);
    await expect(
      result?.runtime?.batchEmbed?.({
        agentId: "main",
        chunks: [{ text: "batch document" }],
        wait: true,
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutMs: 10_000,
        debug: () => {},
      }),
    ).resolves.toEqual([[5, 6]]);
    expect(batchEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [{ text: "batch document" }] }),
    );
    expect(result?.provider?.maxInputTokens).toBe(2048);
    await result?.provider?.embedQuery("query", { signal: undefined });
    await result?.provider?.embedBatch(["document"]);
    await result?.provider?.embedBatchInputs?.([{ text: "structured" }]);
    expect(embed).toHaveBeenCalledWith("query", { signal: undefined, inputType: "query" });
    expect(embedBatch).toHaveBeenNthCalledWith(1, ["document"], { inputType: "document" });
    expect(embedBatch).toHaveBeenNthCalledWith(2, [{ text: "structured" }], {
      inputType: "document",
    });
    expect(Reflect.get(result?.provider ?? {}, runtimeFactsKey)).toBe(runtimeFacts);
    await result?.provider?.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves memory policy and batching after generic registration", async () => {
    const embedQuery = vi.fn(async () => [1, 2]);
    const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [3, 4]));
    const acquireLocalService = vi.fn();
    const create = vi.fn(async (options: unknown) => {
      expect(options).toMatchObject({ acquireLocalService });
      return {
        provider: {
          id: "migrated-memory",
          model: "migrated-model",
          embedQuery,
          embedBatch,
        },
        runtime: {
          id: "migrated-memory",
          sourceWideBatchEmbed: true,
        },
      };
    });
    const memoryAdapter = {
      id: "migrated-memory",
      autoSelectPriority: 20,
      allowExplicitWhenConfiguredAuto: true,
      create,
    } satisfies MemoryEmbeddingProviderAdapter;
    registerEmbeddingProvider(adaptMemoryEmbeddingProviderAdapter(memoryAdapter));

    const adapter = runtimeModule.getMemoryEmbeddingProvider("migrated-memory");
    expect(adapter).toMatchObject({
      id: "migrated-memory",
      autoSelectPriority: 20,
      allowExplicitWhenConfiguredAuto: true,
    });
    const result = await adapter?.create({
      config: {},
      model: "migrated-model",
      acquireLocalService,
    } as never);
    await expect(result?.provider?.embedQuery("query")).resolves.toEqual([1, 2]);
    await expect(result?.provider?.embedBatch(["document"])).resolves.toEqual([[3, 4]]);
    expect(result?.runtime?.sourceWideBatchEmbed).toBe(true);
    expect(embedQuery).toHaveBeenCalledWith("query", { inputType: "query" });
    expect(embedBatch).toHaveBeenCalledWith(["document"], { inputType: "document" });
  });
});
