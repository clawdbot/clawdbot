// Covers memory embedding provider runtime hooks from plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";

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

  it("returns generic provider, runtime, and identity objects unchanged", async () => {
    const close = vi.fn();
    const embed = vi.fn(async () => [1, 2]);
    const embedBatch = vi.fn(async (inputs: unknown[]) => inputs.map(() => [3, 4]));
    const runtime = { id: "generic", inlineQueryTimeoutMs: 1234 };
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
    const options = { config: {}, model: "generic-model", dimensions: 7 };
    expect(adapter?.resolveIndexIdentity?.(options)).toEqual({
      model: "generic-model",
      cacheKeyData: { dimensions: 7 },
    });

    const result = await adapter?.create(options);
    expect(create).toHaveBeenCalledWith(options);
    expect(result?.runtime).toBe(runtime);
    expect(result?.provider).toBe(provider);
    expect(Reflect.get(provider, runtimeFactsKey)).toBe(runtimeFacts);
  });

  it("preserves private memory metadata through generic registration", () => {
    const memoryAdapter = {
      id: "migrated-memory",
      autoSelectPriority: 20,
      allowExplicitWhenConfiguredAuto: true,
      supportsMultimodalEmbeddings: ({ model }: { model: string }) => model === "multimodal",
      shouldContinueAutoSelection: () => true,
      create: async () => ({ provider: null }),
    } satisfies MemoryEmbeddingProviderAdapter;
    registerEmbeddingProvider(memoryAdapter);

    const adapter = runtimeModule.getMemoryEmbeddingProvider("migrated-memory");
    expect(adapter).toBe(memoryAdapter);
    expect(adapter?.supportsMultimodalEmbeddings?.({ model: "multimodal" })).toBe(true);
    expect(adapter?.shouldContinueAutoSelection?.(new Error("setup"))).toBe(true);
  });
});
