// Covers memory embedding provider runtime hooks from plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEmbeddingProviders, registerEmbeddingProvider } from "./embedding-providers.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
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

function createCapabilityAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(async () => {
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  runtimeModule = await import("./memory-embedding-provider-runtime.js");
});

afterEach(() => {
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
});

describe("memory embedding provider runtime resolution", () => {
  it("merges registered and declared capability fallback adapters", () => {
    registerMemoryEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
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
      "ollama",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "memoryEmbeddingProviders",
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

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-5080", config as never)).toBe(
      ollamaAdapter,
    );
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "memoryEmbeddingProviders",
      providerId: "ollama-5080",
      cfg: config,
    });
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "memoryEmbeddingProviders",
      providerId: "ollama",
      cfg: config,
    });
  });

  it("uses registered adapters through a configured provider api", () => {
    const ollamaAdapter = createCapabilityAdapter("ollama");
    registerMemoryEmbeddingProvider(ollamaAdapter);
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

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-gpu1", config)).toBe(ollamaAdapter);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "memoryEmbeddingProviders",
      providerId: "ollama-gpu1",
      cfg: config,
    });
  });

  it("prefers registered adapters over declared capability fallback adapters with the same id", () => {
    const registered = {
      id: "openai",
      create: async () => ({ provider: null }),
    } satisfies MemoryEmbeddingProviderAdapter;
    registerMemoryEmbeddingProvider({
      ...registered,
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("openai")]);

    expect(runtimeModule.getMemoryEmbeddingProvider("openai")).toStrictEqual(registered);
    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai",
    ]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("adapts generic providers once without adding them to memory auto-selection", async () => {
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
    expect(runtimeModule.listMemoryEmbeddingProviders()).toEqual([]);
    const options = { config: {}, model: "generic-model", outputDimensionality: 7 };
    expect(adapter?.resolveIndexIdentity?.(options)).toEqual({
      model: "generic-model",
      cacheKeyData: { dimensions: 7 },
    });

    const result = await adapter?.create(options);
    expect(create).toHaveBeenCalledWith({ ...options, dimensions: 7 });
    expect(result?.runtime).toBe(runtime);
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

  it("keeps memory-specific adapters authoritative during dual registration", () => {
    const memoryAdapter = createCapabilityAdapter("dual");
    registerMemoryEmbeddingProvider(memoryAdapter);
    registerEmbeddingProvider({ id: "dual", create: async () => ({ provider: null }) });

    expect(runtimeModule.getMemoryEmbeddingProvider("dual")).toBe(memoryAdapter);
  });
});
