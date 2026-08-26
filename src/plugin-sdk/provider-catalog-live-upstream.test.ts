import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  clearLiveCatalogCacheForTests,
  getCachedUpstreamProviderCatalog,
  projectUpstreamProviderCatalogModel,
  type LiveModelCatalogFetchGuard,
  type UpstreamProviderCatalog,
} from "./provider-catalog-live-runtime.js";

function buildFetchGuard(body: unknown): {
  fetchGuard: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://models.opencode.ai/api.json",
    release,
  }));
  return { fetchGuard, release };
}

describe("shared upstream provider metadata catalogs", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());

  it("lazily shares one anonymous upstream metadata download across provider ids", async () => {
    const { fetchGuard, release } = buildFetchGuard({
      opencode: { id: "opencode", api: "https://opencode.ai/zen/v1", models: {} },
      "opencode-go": { id: "opencode-go", api: "https://opencode.ai/zen/go/v1", models: {} },
    });
    const endpoint = "https://models.opencode.ai/api.json";

    expect(fetchGuard).not.toHaveBeenCalled();
    const providers = await Promise.all([
      getCachedUpstreamProviderCatalog({ endpoint, providerId: "missing", fetchGuard }),
      getCachedUpstreamProviderCatalog({ endpoint, providerId: "opencode", fetchGuard }),
      getCachedUpstreamProviderCatalog({ endpoint, providerId: "opencode-go", fetchGuard }),
    ]);

    expect(providers.map((provider) => provider?.id)).toEqual([
      undefined,
      "opencode",
      "opencode-go",
    ]);
    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(fetchGuard.mock.calls[0]?.[0]).toMatchObject({
      url: endpoint,
      requireHttps: true,
      timeoutMs: 15_000,
      auditContext: "upstream-provider-catalog-discovery",
    });
    expect(
      new Headers(fetchGuard.mock.calls[0]?.[0].init?.headers).get("authorization"),
    ).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("accepts shared upstream feeds beyond the ordinary four-megabyte provider limit", async () => {
    const { fetchGuard } = buildFetchGuard({
      padding: "x".repeat(4 * 1024 * 1024),
      opencode: { id: "opencode", models: {} },
    });

    await expect(
      getCachedUpstreamProviderCatalog({
        endpoint: "https://models.opencode.ai/api.json",
        providerId: "opencode",
        fetchGuard,
      }),
    ).resolves.toMatchObject({ id: "opencode" });
  });

  it("rejects shared upstream feeds beyond their separate eight-megabyte ceiling", async () => {
    const { fetchGuard, release } = buildFetchGuard({
      padding: "x".repeat(8 * 1024 * 1024),
      opencode: { id: "opencode", models: {} },
    });

    await expect(
      getCachedUpstreamProviderCatalog({
        endpoint: "https://models.opencode.ai/api.json",
        providerId: "opencode",
        fetchGuard,
      }),
    ).rejects.toThrow("Live model catalog response exceeded 8388608 bytes");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("projects authoritative upstream pricing, reasoning, tool, and modality metadata", () => {
    const provider: UpstreamProviderCatalog = {
      id: "opencode-go",
      api: "https://opencode.ai/zen/go/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {},
    };
    const model = projectUpstreamProviderCatalogModel({
      providerId: provider.id,
      provider,
      model: {
        id: "frontier-model",
        name: "Frontier Model",
        reasoning: true,
        tool_call: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "high", null] }],
        modalities: { input: ["text", "image", "video"] },
        provider: { npm: "@ai-sdk/openai" },
        limit: { context: 1_000_000, input: 900_000, output: 128_000 },
        cost: {
          input: 2,
          output: 6,
          cache_read: 0.5,
          cache_write: 1,
          tiers: [
            {
              input: 4,
              output: 12,
              cache_read: 1,
              cache_write: 2,
              tier: { type: "context", size: 200_000 },
            },
          ],
        },
      },
    });

    expect(model).toEqual({
      id: "frontier-model",
      name: "Frontier Model",
      provider: "opencode-go",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 900_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null },
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.5,
        cacheWrite: 1,
        tieredPricing: [
          { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 1, range: [0, 200_000] },
          { input: 4, output: 12, cacheRead: 1, cacheWrite: 2, range: [200_000] },
        ],
      },
      compat: {
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        supportsTools: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "high"],
      },
    });
  });

  it.each([
    ["@ai-sdk/openai-compatible", "openai-completions", "https://opencode.ai/zen/v1"],
    ["@ai-sdk/openai", "openai-responses", "https://opencode.ai/zen/v1"],
    ["@ai-sdk/anthropic", "anthropic-messages", "https://opencode.ai/zen"],
    ["@ai-sdk/google", "google-generative-ai", "https://opencode.ai/zen/v1"],
  ])("projects upstream %s transport without guessing from model ids", (npm, api, baseUrl) => {
    const provider: UpstreamProviderCatalog = {
      id: "opencode",
      api: "https://opencode.ai/zen/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {},
    };

    expect(
      projectUpstreamProviderCatalogModel({
        providerId: provider.id,
        provider,
        model: {
          id: "opaque-preview-id",
          name: "Opaque Preview",
          provider: { npm },
          limit: { context: 128_000, output: 8192 },
        },
      }),
    ).toMatchObject({ api, baseUrl });
  });

  it("rejects upstream metadata that would redirect authenticated inference to another origin", () => {
    const provider: UpstreamProviderCatalog = {
      id: "opencode",
      api: "https://opencode.ai/zen/v1",
      models: {},
    };
    const model = {
      id: "opaque-preview-id",
      name: "Opaque Preview",
      limit: { context: 128_000, output: 8192 },
    };

    expect(
      projectUpstreamProviderCatalogModel({
        providerId: provider.id,
        provider,
        model: { ...model, provider: { api: "https://attacker.example/v1" } },
      }),
    ).toBeUndefined();
    expect(
      projectUpstreamProviderCatalogModel({
        providerId: provider.id,
        provider: { ...provider, api: "https://attacker.example/v1" },
        model,
        defaultBaseUrl: "https://opencode.ai/zen/v1",
      }),
    ).toBeUndefined();
  });
});
