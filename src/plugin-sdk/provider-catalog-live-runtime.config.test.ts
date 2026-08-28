import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import {
  buildLiveCatalogFetchGuard,
  buildLiveCatalogTestModel,
} from "./provider-catalog-live-runtime.test-support.js";

describe("provider-catalog-live-runtime provider configs", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects malformed UTF-8 bytes in live catalog responses and falls back to static rows", async () => {
    // Build raw bytes with a 0xFE byte inside the JSON payload — 0xFE is never
    // a valid UTF-8 lead byte, so fatal:true throws before JSON.parse.
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"data":[{"id":"model-a","label":"test-');
    const suffix = encoder.encode('"}]}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix, 0);
    // Inject an invalid UTF-8 byte before the suffix
    body[prefix.length] = 0xfe;
    body.set(suffix, prefix.length + 1);

    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(body),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildLiveCatalogTestModel("model-a"), buildLiveCatalogTestModel("model-b")];

    const result = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      fetchGuard: fetchGuardMock,
      models,
    });

    // The malformed UTF-8 causes readLiveModelCatalogJson to throw.
    // buildLiveModelProviderConfig should catch it and return the static catalog.
    expect(result.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(result.apiKey).toBe("PROVIDER_API_KEY");
    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caches live provider configs and falls back to static rows on failure", async () => {
    const { fetchGuard, fetchGuardMock } = buildLiveCatalogFetchGuard([
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildLiveCatalogTestModel("model-a"), buildLiveCatalogTestModel("model-b")];

    const first = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });
    const second = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(second.models.map((model) => model.id)).toEqual(["model-b"]);

    clearLiveCatalogCacheForTests();
    fetchGuardMock.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    });

    expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });

  it("does not cache empty live provider config discoveries", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      });
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildLiveCatalogTestModel("model-a"), buildLiveCatalogTestModel("model-b")];

    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });
    const recovered = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });

    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(recovered.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });

  it("builds newly listed text models from OpenAI-compatible catalog metadata", async () => {
    const { fetchGuard, fetchGuardMock } = buildLiveCatalogFetchGuard({
      data: [
        {
          id: "chat-v2",
          object: "model",
          active: true,
          context_window: 262_144,
          max_completion_tokens: 32_768,
          input_modalities: ["text", "image"],
          features: ["reasoning"],
        },
        { id: "text-embedding-4", object: "model" },
        { id: "gpt-image-2-oai", object: "model" },
        { id: "retired-chat", object: "model", active: false },
        { id: "archived-chat", object: "model", archived: true },
        { id: "deprecated-chat", object: "model", deprecated: true },
        {
          id: "fim-only",
          object: "model",
          capabilities: { completion_chat: false, completion_fim: true },
        },
        { id: "image-generation-v2", object: "model", features: ["image_generation"] },
        {
          id: "chat-and-image-v2",
          object: "model",
          capabilities: { completion_chat: true },
          features: ["image_generation"],
        },
        {
          id: "image-only",
          object: "model",
          output_modalities: ["image"],
        },
      ],
    });

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1/",
        models: [buildLiveCatalogTestModel("chat-v1")],
      },
      apiKey: "provider-key",
      fetchGuard,
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ id: "chat-and-image-v2" }),
      expect.objectContaining({
        id: "chat-v2",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 32_768,
      }),
    ]);
    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer provider-key");
  });

  it("keeps authored static metadata for live ids already in the provider seed", async () => {
    const { fetchGuard } = buildLiveCatalogFetchGuard({
      data: [{ id: "chat-v1", object: "model", context_window: 1 }],
    });
    const seed = buildLiveCatalogTestModel("chat-v1");

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        models: [seed],
      },
      fetchGuard,
    });

    expect(provider.models).toEqual([seed]);
  });

  it("supports provider-specific model-list paths and headers", async () => {
    const { fetchGuard, fetchGuardMock } = buildLiveCatalogFetchGuard({
      data: [{ id: "claude-next", object: "model" }],
    });

    await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "anthropic-style",
      providerConfig: {
        api: "anthropic-messages",
        baseUrl: "https://provider.example.test",
        models: [buildLiveCatalogTestModel("claude-current")],
      },
      apiKey: "provider-key",
      modelDiscovery: {
        endpointPath: "v1/models",
        buildRequestHeaders: ({ apiKey }) => ({
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        }),
      },
      fetchGuard,
    });

    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-api-key")).toBe("provider-key");
    expect((headers as Headers).get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not send credentials to a fixed discovery endpoint after a base URL override", async () => {
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn();
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://private-proxy.example.test/v1",
      models: [buildLiveCatalogTestModel("chat-current")],
    };

    await expect(
      buildOpenAICompatibleLiveModelProviderConfig({
        providerId: "provider",
        providerConfig,
        apiKey: "private-proxy-key",
        modelDiscovery: {
          endpointUrl: {
            url: "https://provider.example.test/v1/models",
            requireBaseUrl: "https://provider.example.test/v1",
          },
        },
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual({ ...providerConfig, apiKey: "private-proxy-key" });

    expect(fetchGuardMock).not.toHaveBeenCalled();
  });
});
