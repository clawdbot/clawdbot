// Covers embedding provider runtime hooks supplied by plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";

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
  runtimeModule = await import("./embedding-provider-runtime.js");
});

afterEach(() => {
  clearEmbeddingProviders();
});

describe("embedding provider runtime resolution", () => {
  it("merges registered and declared capability fallback adapters", () => {
    registerEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "registered",
      "capability",
    ]);
    expect(runtimeModule.getEmbeddingProvider("registered")?.id).toBe("registered");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "ollama",
    ]);
    expect(runtimeModule.getEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama",
      cfg: undefined,
    });
  });

  it("keeps OpenAI-compatible available as an explicit core provider", () => {
    expect(runtimeModule.getEmbeddingProvider("openai-compatible")?.id).toBe("openai-compatible");
  });

  it("maps configured OpenAI-compatible provider ids to the core adapter", () => {
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

    expect(runtimeModule.getEmbeddingProvider("tenant-embeddings", cfg)?.id).toBe(
      "openai-compatible",
    );
    expect(mocks.resolvePluginCapabilityProvider).not.toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "tenant-embeddings",
      cfg,
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

    expect(runtimeModule.getEmbeddingProvider("openai")).toStrictEqual(registered);
    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "openai",
    ]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });
});
