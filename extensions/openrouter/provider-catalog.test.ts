import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterLiveProvider } from "./provider-catalog.js";

describe("OpenRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("discovers text models and preserves bundled routes", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        data: [
          {
            id: "acme/partial-pricing",
            name: "Partial Pricing Fixture",
            architecture: {
              input_modalities: ["text", "image", "audio", "video"],
              output_modalities: ["text"],
            },
            supported_parameters: ["reasoning", "tools"],
            context_length: 1_048_576,
            top_provider: {
              context_length: 1_048_576,
              max_completion_tokens: 65_536,
            },
            pricing: {
              prompt: "0.0000015",
              completion: "0.0000075",
              input_cache_read: "0.00000015",
              input_cache_write: "0.0000025",
              overrides: [
                {
                  min_prompt_tokens: 272_000,
                  prompt: "0.000004",
                },
              ],
            },
          },
          {
            id: "google/gemini-3.5-flash-lite",
            architecture: { modality: "text+image->text" },
            supported_parameters: ["include_reasoning"],
            context_length: 1_048_576,
            max_completion_tokens: 65_536,
            pricing: { prompt: "0.0000003", completion: "0.0000025" },
          },
          {
            id: "google/gemini-3.1-flash-image",
            architecture: { modality: "text+image->image" },
            context_length: 65_536,
          },
        ],
      }),
      finalUrl: url,
      release,
    }));

    const provider = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      discoveryApiKey: "resolved-openrouter-key",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("OPENROUTER_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "openrouter/auto",
        "google/gemini-3.5-flash-lite",
        "acme/partial-pricing",
      ]),
    );
    expect(provider.models.map((model) => model.id)).not.toContain("google/gemini-3.1-flash-image");
    expect(provider.models.find((model) => model.id === "acme/partial-pricing")).toMatchObject({
      name: "Partial Pricing Fixture",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      cost: {
        input: 1.5,
        output: 7.5,
        cacheRead: 0.15,
        cacheWrite: 2.5,
        tieredPricing: [
          { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 2.5, range: [0, 272_001] },
          {
            input: 4,
            output: 7.5,
            cacheRead: 0.15,
            cacheWrite: 2.5,
            range: [272_001],
          },
        ],
      },
    });
    expect(
      new Headers(vi.mocked(fetchGuard).mock.calls[0]?.[0].init?.headers).get("authorization"),
    ).toBe("Bearer resolved-openrouter-key");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps custom provider credentials and request headers on the configured catalog origin", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({ data: [{ id: "custom/private-model" }] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    const provider = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      discoveryApiKey: "synthetic-private-proxy-key",
      baseUrl: "https://private.example.invalid/router/v1///",
      request: {
        headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" },
      },
      fetchGuard,
    });

    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://private.example.invalid/router/v1/models");
    expect(provider.baseUrl).toBe("https://private.example.invalid/router/v1");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-private-proxy-key");
    expect(headers.get("x-private-proxy-tenant")).toBe("synthetic-tenant");
    expect(request?.policy).toEqual({
      allowedOrigins: ["https://private.example.invalid"],
    });
  });

  it.each(["https://openrouter.ai/api/v1///", "https://openrouter.ai/v1/"])(
    "preserves the canonical endpoint for the official alias %s",
    async (baseUrl) => {
      const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
        response: Response.json({ data: [{ id: "openrouter/auto" }] }),
        finalUrl: url,
        release: async () => undefined,
      }));

      const provider = await buildOpenrouterLiveProvider({
        apiKey: "synthetic-official-key",
        baseUrl,
        fetchGuard,
      });

      expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(vi.mocked(fetchGuard).mock.calls[0]?.[0].url).toBe(
        "https://openrouter.ai/api/v1/models",
      );
    },
  );

  it.each([
    "not a URL",
    "file:///tmp/openrouter",
    `https://${["user", "pass"].join(":")}@private.example.invalid/v1`,
    "https://private.example.invalid/v1?token=synthetic-secret",
    "https://private.example.invalid/v1#synthetic-secret",
  ])("rejects malformed credential destinations before fetching: %s", async (baseUrl) => {
    const fetchGuard = vi.fn() as unknown as LiveModelCatalogFetchGuard;

    await expect(
      buildOpenrouterLiveProvider({ apiKey: "synthetic-private-key", baseUrl, fetchGuard }),
    ).rejects.toThrow("Invalid OpenRouter API base URL");
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("never sends non-secret API-key markers as catalog bearer credentials", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({ data: [{ id: "private/model" }] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      baseUrl: "https://private.example.invalid/v1",
      fetchGuard,
    });

    expect(
      new Headers(vi.mocked(fetchGuard).mock.calls[0]?.[0].init?.headers).has("authorization"),
    ).toBe(false);
  });

  it("isolates successful discovery caches by credential destination and request policy", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({ data: [{ id: "private/model" }] }),
      finalUrl: url,
      release: async () => undefined,
    }));
    const base = { apiKey: "synthetic-private-key", fetchGuard };
    const tenantA = { headers: { "X-Private-Proxy-Tenant": "tenant-a" } };
    const tenantB = { headers: { "X-Private-Proxy-Tenant": "tenant-b" } };

    await buildOpenrouterLiveProvider({
      ...base,
      baseUrl: "https://first.invalid/v1",
      request: tenantA,
    });
    await buildOpenrouterLiveProvider({
      ...base,
      baseUrl: "https://first.invalid/v1",
      request: tenantB,
    });
    await buildOpenrouterLiveProvider({
      ...base,
      baseUrl: "https://second.invalid/v1",
      request: tenantA,
    });
    await buildOpenrouterLiveProvider({
      ...base,
      baseUrl: "https://first.invalid/v1",
      request: tenantA,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetchGuard).mock.calls.map(([request]) => request.url)).toEqual([
      "https://first.invalid/v1/models",
      "https://first.invalid/v1/models",
      "https://second.invalid/v1/models",
    ]);
  });

  it("honors configured proxy transport, custom auth, and explicitly denied private-network access", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({ data: [{ id: "private/model" }] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await buildOpenrouterLiveProvider({
      apiKey: "synthetic-original-key",
      baseUrl: "https://private.example.invalid/router/v1",
      request: {
        allowPrivateNetwork: false,
        auth: { mode: "header", headerName: "X-Proxy-Key", value: "synthetic-override-key" },
        proxy: { mode: "explicit-proxy", url: "https://corporate-proxy.example.invalid" },
      },
      fetchGuard,
    });

    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("x-proxy-key")).toBe("synthetic-override-key");
    expect(headers.has("authorization")).toBe(false);
    expect(request?.policy).toEqual({});
    expect(request?.dispatcherPolicy).toMatchObject({
      mode: "explicit-proxy",
      proxyUrl: "https://corporate-proxy.example.invalid",
    });
  });

  it("does not follow cross-origin catalog pagination with private credentials", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        data: [{ id: "private/model" }],
        next: "https://attacker.example.invalid/models?page=2",
      }),
      finalUrl: url,
      release,
    }));

    await expect(
      buildOpenrouterLiveProvider({
        apiKey: "synthetic-private-key",
        baseUrl: "https://private.example.invalid/v1",
        fetchGuard,
      }),
    ).rejects.toThrow("did not include a supported next page");

    expect(fetchGuard).toHaveBeenCalledOnce();
    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://private.example.invalid/v1/models");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-private-key",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("strips private bearer and custom auth headers after a guarded cross-origin redirect", async () => {
    let requestCount = 0;
    const redirectedUrl = "https://redirect.example.invalid/catalog";
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => {
      requestCount += 1;
      return {
        response: Response.json({
          data: [{ id: `private/model-${requestCount}` }],
          ...(requestCount === 1 ? { next: `${redirectedUrl}?page=2` } : {}),
        }),
        finalUrl: requestCount === 1 ? redirectedUrl : url,
        release: async () => undefined,
      };
    });

    await buildOpenrouterLiveProvider({
      apiKey: "synthetic-private-key",
      baseUrl: "https://private.example.invalid/v1",
      request: { headers: { "X-Private-Proxy-Tenant": "synthetic-secret-tenant" } },
      fetchGuard,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    const redirectedHeaders = new Headers(vi.mocked(fetchGuard).mock.calls[1]?.[0].init?.headers);
    expect(redirectedHeaders.has("authorization")).toBe(false);
    expect(redirectedHeaders.has("x-private-proxy-tenant")).toBe(false);
  });

  it("fails closed before discovery when configured request secrets are unresolved", async () => {
    const fetchGuard = vi.fn() as unknown as LiveModelCatalogFetchGuard;

    await expect(
      buildOpenrouterLiveProvider({
        apiKey: "synthetic-private-key",
        baseUrl: "https://private.example.invalid/v1",
        request: {
          headers: {
            "X-Private-Proxy-Tenant": {
              source: "env",
              provider: "default",
              id: "SYNTHETIC_MISSING_SECRET",
            },
          },
        },
        fetchGuard,
      }),
    ).rejects.toThrow();
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("caches live discovery and propagates acquisition failure", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        data: [
          {
            id: "google/gemini-3.6-flash",
            architecture: { modality: "text->text" },
          },
        ],
      }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await buildOpenrouterLiveProvider({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    await buildOpenrouterLiveProvider({
      apiKey: "runtime-b",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    expect(fetchGuard).toHaveBeenCalledOnce();

    clearLiveCatalogCacheForTests();
    vi.mocked(fetchGuard).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(
      buildOpenrouterLiveProvider({
        apiKey: "runtime-a",
        discoveryApiKey: "discovery-a",
        fetchGuard,
      }),
    ).rejects.toThrow("network unavailable");
  });
});
