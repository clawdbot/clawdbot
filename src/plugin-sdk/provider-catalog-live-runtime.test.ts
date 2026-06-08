import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function buildFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("fetches and dedupes OpenAI-style live model ids with resolved discovery auth", async () => {
    const { fetchGuard, fetchGuardMock, release } = buildFetchGuard({
      data: [
        { id: "model-a", object: "model" },
        { id: "model-b", object: "model" },
        { id: "embedding-a", object: "embedding" },
        { id: "model-a", object: "model" },
      ],
    });
    const controller = new AbortController();

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: "PROVIDER_API_KEY",
        discoveryApiKey: "resolved-provider-key",
        fetchGuard,
        signal: controller.signal,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    const request = fetchGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://provider.example.test/v1/models",
      auditContext: "provider-model-discovery",
      timeoutMs: 1234,
      signal: controller.signal,
    });
    const headers = request?.init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer resolved-provider-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({ data: [] });
    const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: NON_ENV_SECRETREF_MARKER,
        fetchGuard,
        buildRequestHeaders,
      }),
    ).resolves.toEqual([]);

    expect(buildRequestHeaders).toHaveBeenCalledWith({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect((headers as Headers).get("x-api-key")).toBeNull();
  });

  it("supports top-level array bodies and custom row readers", async () => {
    const { fetchGuard } = buildFetchGuard([
      { slug: "custom-a" },
      { slug: "custom-b" },
      { slug: "custom-a" },
    ]);

    await expect(
      fetchLiveProviderModelIds({
        providerId: "custom",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard,
        readModelId: (row) =>
          row && typeof row === "object" && "slug" in row && typeof row.slug === "string"
            ? row.slug
            : undefined,
      }),
    ).resolves.toEqual(["custom-a", "custom-b"]);
  });

  it("caches raw live model rows for provider-specific projection", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      models: [{ slug: "custom-a" }, { slug: "custom-b" }],
    });

    const first = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });
    const second = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });

    expect(first).toEqual([{ slug: "custom-a" }, { slug: "custom-b" }]);
    expect(second).toEqual(first);
    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("throws structured HTTP errors after releasing guarded fetches", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response("{}", { status: 401 }),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caches live provider configs and falls back to static rows on failure", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard([
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

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
    const models = [buildModel("model-a"), buildModel("model-b")];

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
});
