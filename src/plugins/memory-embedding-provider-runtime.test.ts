import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  clearMemoryEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  runtimeModule = await import("./memory-embedding-provider-runtime.js");
});

afterEach(() => {
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

  it("prefers registered adapters over declared capability fallback adapters with the same id", () => {
    const registered = {
      id: "openai",
      create: async () => ({ provider: null }),
    } satisfies MemoryEmbeddingProviderAdapter;
    registerMemoryEmbeddingProvider({
      ...registered,
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("openai")]);

    expect(runtimeModule.getMemoryEmbeddingProvider("openai")).toEqual(
      expect.objectContaining({ id: "openai" }),
    );
    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai",
    ]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });
});
