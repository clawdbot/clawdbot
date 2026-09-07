// Covers embedding provider runtime hooks supplied by plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { PluginRegistryResourceScope } from "./registry-resources.js";

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

let runtimeModule: typeof import("./embedding-provider-runtime.js");
let resources: PluginRegistryResourceScope;

function createCapabilityAdapter(id: string): EmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(async () => {
  resources = new PluginRegistryResourceScope();
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  const runtime = await import("./embedding-provider-runtime.js");
  runtimeModule = {
    ...runtime,
    getEmbeddingProviderCore: (...args) =>
      resources.run(() => runtime.getEmbeddingProviderCore(...args)),
    listEmbeddingProvidersCore: (...args) =>
      resources.run(() => runtime.listEmbeddingProvidersCore(...args)),
  };
});

afterEach(async () => {
  resources.release();
  await resources.waitForDisposals();
  clearEmbeddingProviders();
});

describe("embedding provider runtime resolution", () => {
  it("merges registered and declared capability fallback adapters", () => {
    registerEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listEmbeddingProvidersCore().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "registered",
      "capability",
    ]);
    expect(runtimeModule.getEmbeddingProviderCore("registered")?.id).toBe("registered");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(runtimeModule.listEmbeddingProvidersCore().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "ollama",
    ]);
    expect(runtimeModule.getEmbeddingProviderCore("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama",
      cfg: undefined,
    });
  });

  it("keeps OpenAI-compatible available as an explicit core provider", () => {
    expect(runtimeModule.getEmbeddingProviderCore("openai-compatible")?.id).toBe(
      "openai-compatible",
    );
  });

  it("maps configured OpenAI-compatible provider ids to the core adapter when no exact provider exists", () => {
    const cfg = {
      models: {
        providers: {
          "tenant-embeddings": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(runtimeModule.getEmbeddingProviderCore("tenant-embeddings", cfg)?.id).toBe(
      "openai-compatible",
    );
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "tenant-embeddings",
      cfg,
    });
  });

  it("prefers an exact plugin adapter over a configured OpenAI-compatible alias", () => {
    const adapter = createCapabilityAdapter("tenant-embeddings");
    const cfg = {
      models: {
        providers: {
          "tenant-embeddings": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "tenant-embeddings" ? adapter : undefined,
    );

    expect(runtimeModule.getEmbeddingProviderCore("tenant-embeddings", cfg)).toBe(adapter);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledOnce();
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

    expect(runtimeModule.getEmbeddingProviderCore("openai")).toStrictEqual(registered);
    expect(runtimeModule.listEmbeddingProvidersCore().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "openai",
    ]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });
});
