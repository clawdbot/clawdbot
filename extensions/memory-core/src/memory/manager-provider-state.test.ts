// Memory Core tests cover manager.mistral provider plugin behavior.
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import {
  applyMemoryFallbackProviderState,
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";

const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
    providerId === "ollama"
      ? DEFAULT_OLLAMA_EMBEDDING_MODEL
      : providerId === "lmstudio"
        ? DEFAULT_LMSTUDIO_EMBEDDING_MODEL
        : fallbackSourceModel,
}));

type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

type EmbeddingProviderRuntime = {
  id: string;
  cacheKeyData: { provider: string; model: string };
};

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: `${id}-model`,
    embedQuery: async () => [0.1, 0.2, 0.3],
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  };
}

function createSettings(params: {
  provider: "openai" | "mistral";
  fallback?: "none" | "mistral" | "ollama" | "lmstudio";
}): ResolvedMemorySearchConfig {
  return {
    provider: params.provider,
    model: params.provider === "mistral" ? "mistral/mistral-embed" : "text-embedding-3-small",
    fallback: params.fallback ?? "none",
    remote: undefined,
    outputDimensionality: undefined,
    local: undefined,
  } as unknown as ResolvedMemorySearchConfig;
}

type MemoryFallbackProviderRequest = NonNullable<
  ReturnType<typeof resolveMemoryFallbackProviderRequest>
>;

function expectMemoryFallbackRequest(
  request: ReturnType<typeof resolveMemoryFallbackProviderRequest>,
): MemoryFallbackProviderRequest {
  if (!request) {
    throw new Error("Expected memory fallback provider request");
  }
  return request;
}

describe("memory manager mistral provider wiring", () => {
  it("stores mistral client when mistral provider is selected", () => {
    const mistralProvider = createProvider("mistral");
    const mistralRuntime: EmbeddingProviderRuntime = {
      id: "mistral",
      cacheKeyData: { provider: "mistral", model: "mistral-embed" },
    };

    const state = resolveMemoryProviderState({
      provider: mistralProvider,
      requestedProvider: "mistral",
      runtime: mistralRuntime,
      fallbackFrom: undefined,
      fallbackReason: undefined,
      providerUnavailableReason: undefined,
    });

    expect(state.provider).toBe(mistralProvider);
    expect(state.providerRuntime).toBe(mistralRuntime);
  });

  it("stores mistral client after fallback activation", () => {
    const openAiRuntime: EmbeddingProviderRuntime = {
      id: "openai",
      cacheKeyData: { provider: "openai", model: "text-embedding-3-small" },
    };
    const mistralRuntime: EmbeddingProviderRuntime = {
      id: "mistral",
      cacheKeyData: { provider: "mistral", model: "mistral-embed" },
    };
    const mistralProvider = createProvider("mistral");
    const current = resolveMemoryProviderState({
      provider: createProvider("openai"),
      requestedProvider: "openai",
      runtime: openAiRuntime,
      fallbackFrom: undefined,
      fallbackReason: undefined,
      providerUnavailableReason: undefined,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current,
      fallbackFrom: "openai",
      reason: "forced test",
      result: {
        provider: mistralProvider,
        runtime: mistralRuntime,
      },
    });

    expect(fallbackState.fallbackFrom).toBe("openai");
    expect(fallbackState.fallbackReason).toBe("forced test");
    expect(fallbackState.provider).toBe(mistralProvider);
    expect(fallbackState.providerRuntime).toBe(mistralRuntime);
  });

  it("clears provider unavailable reason after fallback activation", () => {
    const fallbackState = applyMemoryFallbackProviderState({
      current: resolveMemoryProviderState({
        provider: null,
        requestedProvider: "local",
        fallbackFrom: undefined,
        fallbackReason: undefined,
        providerUnavailableReason: "Local embeddings degraded: worker crashed",
        runtime: undefined,
      }),
      fallbackFrom: "local",
      reason: "worker crashed",
      result: {
        provider: createProvider("openai"),
        runtime: {
          id: "openai",
          cacheKeyData: { provider: "openai", model: "text-embedding-3-small" },
        },
      },
    });

    expect(fallbackState.providerUnavailableReason).toBeUndefined();
  });

  it.each([
    { provider: "ollama" as const, model: DEFAULT_OLLAMA_EMBEDDING_MODEL },
    { provider: "lmstudio" as const, model: DEFAULT_LMSTUDIO_EMBEDDING_MODEL },
    { provider: "mistral" as const, model: "text-embedding-3-small" },
  ])(
    "keeps the primary endpoint and credentials out of the $provider runtime fallback",
    ({ provider, model }) => {
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
        apiKey: "test-key",
        headers: {
          Authorization: "Bearer test-secret",
          "X-OpenAI-Secret": "test-token",
        },
        ...sharedRemote,
      };
      const local = { modelPath: "/tmp/synthetic-memory-model.gguf", contextSize: 2048 };
      const settings = {
        ...createSettings({ provider: "openai", fallback: provider }),
        remote,
        inputType: "passage",
        queryInputType: "query",
        documentInputType: "document",
        outputDimensionality: 768,
        local,
      } satisfies ResolvedMemorySearchConfig;

      expect(resolveMemoryPrimaryProviderRequest({ settings }).remote).toBe(remote);

      const fallbackRequest = expectMemoryFallbackRequest(
        resolveMemoryFallbackProviderRequest({
          cfg: {} as OpenClawConfig,
          settings,
          currentProviderId: "openai",
        }),
      );

      expect(fallbackRequest).toMatchObject({
        provider,
        model,
        fallback: "none",
        remote: sharedRemote,
        inputType: "passage",
        queryInputType: "query",
        documentInputType: "document",
        outputDimensionality: 768,
        local,
      });
      expect(fallbackRequest.remote).toEqual(sharedRemote);
    },
  );

  it("includes outputDimensionality in the primary provider request", () => {
    const request = resolveMemoryPrimaryProviderRequest({
      settings: {
        ...createSettings({ provider: "mistral" }),
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        outputDimensionality: 1536,
      } as ResolvedMemorySearchConfig,
    });

    expect(request.provider).toBe("gemini");
    expect(request.model).toBe("gemini-embedding-2-preview");
    expect(request.outputDimensionality).toBe(1536);
  });

  it("includes memory input_type fields in the primary provider request", () => {
    const request = resolveMemoryPrimaryProviderRequest({
      settings: {
        ...createSettings({ provider: "openai" }),
        inputType: "passage",
        queryInputType: "query",
        documentInputType: "document",
      } as ResolvedMemorySearchConfig,
    });

    expect(request.inputType).toBe("passage");
    expect(request.queryInputType).toBe("query");
    expect(request.documentInputType).toBe("document");
  });

  it("does not activate a fallback that is already the current provider", () => {
    expect(
      resolveMemoryFallbackProviderRequest({
        cfg: {} as OpenClawConfig,
        settings: createSettings({ provider: "openai", fallback: "lmstudio" }),
        currentProviderId: "lmstudio",
      }),
    ).toBeNull();
  });
});
