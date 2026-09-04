import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
// Nvidia tests cover provider catalog plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildLiveNvidiaProvider,
  buildNvidiaProvider,
  buildSelectableNvidiaProvider,
  buildSelectableLiveNvidiaProvider,
} from "./provider-catalog.js";

const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

const EXPECTED_SELECTABLE_MODELS = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron 3 Ultra 550B",
    contextWindow: 1_048_576,
    maxTokens: 8_192,
  },
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    name: "Nemotron 3.5 Lightning 30B",
    contextWindow: 1_048_576,
    maxTokens: 16_384,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super 120B",
    contextWindow: 1_000_000,
    maxTokens: 8_192,
  },
  { id: "z-ai/glm-5.2", name: "GLM 5.2", contextWindow: 202_752, maxTokens: 8_192 },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "minimaxai/minimax-m3",
    name: "Minimax M3",
    contextWindow: 196_608,
    maxTokens: 8_192,
  },
  {
    id: "deepseek-ai/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 262_144,
    maxTokens: 16_384,
  },
] as const;

const EXPECTED_DEPRECATED_MODELS = [
  {
    id: "qwen/qwen3.5-397b-a17b",
    name: "Qwen3.5 397B A17B",
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
  {
    id: "z-ai/glm-5.1",
    name: "GLM 5.1",
    contextWindow: 202_752,
    maxTokens: 8_192,
  },
  { id: "z-ai/glm5", name: "GLM-5", contextWindow: 202_752, maxTokens: 8_192 },
  {
    id: "minimaxai/minimax-m2.7",
    name: "Minimax M2.7",
    contextWindow: 204_800,
    maxTokens: 16_384,
  },
] as const;

const EXPECTED_BUNDLED_MODELS = [
  ...EXPECTED_SELECTABLE_MODELS,
  ...EXPECTED_DEPRECATED_MODELS,
] as const;

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

const catalogResponses = new Map<
  string,
  Array<{ response: Response; finalUrl: string; release: ReturnType<typeof vi.fn> }>
>();

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
  catalogResponses.clear();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200, inventoryIds?: string[]) {
  const release = vi.fn();
  const featured =
    (payload as { "featured-models"?: Array<{ model: string }> })["featured-models"] ?? [];
  const ids =
    inventoryIds ??
    featured.map((row) => row.model).filter((id) => typeof id === "string" && !/\s/.test(id));
  for (const [url, body] of [
    [
      NVIDIA_MODELS_URL,
      { data: ids.map((id) => ({ id: id.includes("/") ? id : `nvidia/${id}` })) },
    ],
    [NVIDIA_FEATURED_MODELS_URL, payload],
  ] as const) {
    const responses = catalogResponses.get(url) ?? [];
    responses.push({
      response: Response.json(body, { status }),
      finalUrl: url,
      release: url === NVIDIA_FEATURED_MODELS_URL ? release : vi.fn(),
    });
    catalogResponses.set(url, responses);
  }
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
    const response = catalogResponses.get(url)?.shift();
    if (!response) {
      throw new Error(`Unexpected catalog request: ${url}`);
    }
    return response;
  });
  return release;
}

function mockInventoryAndFeatured(params: {
  ids: string[];
  featured: unknown[];
  inventoryStatus?: number;
  featuredStatus?: number;
}) {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response:
      url === NVIDIA_MODELS_URL
        ? Response.json(
            { data: params.ids.map((id) => ({ id, object: "model" })) },
            { status: params.inventoryStatus ?? 200 },
          )
        : Response.json(
            { "featured-models": params.featured },
            { status: params.featuredStatus ?? 200 },
          ),
    finalUrl: url,
    release: vi.fn(),
  }));
}

describe("nvidia provider catalog", () => {
  it("uses the model inventory for availability while retaining featured ordering", async () => {
    mockInventoryAndFeatured({
      ids: [
        "nvidia/nemotron-3-ultra-550b-a55b",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "nvidia/unclassified-new-model",
        "nvidia/nemotron-4-340b-reward",
      ],
      featured: [
        {
          model: "z-ai/glm-5.2",
          "model-name": "Stale featured model",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super",
          context: 1000000,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
  });

  it("preserves known capabilities when a featured row only supplies limits", async () => {
    mockInventoryAndFeatured({
      ids: ["moonshotai/kimi-k2.6"],
      featured: [
        {
          model: "moonshotai/kimi-k2.6",
          "model-name": "Kimi K2.6",
          context: 262144,
          "max-output": 65536,
        },
      ],
    });

    expect((await buildLiveNvidiaProvider()).models).toMatchObject([
      { id: "moonshotai/kimi-k2.6", reasoning: true, input: ["text", "image"] },
    ]);
  });

  it("uses known live models when the featured feed fails", async () => {
    mockInventoryAndFeatured({
      ids: ["nvidia/nemotron-3-ultra-550b-a55b"],
      featured: [],
      featuredStatus: 503,
    });

    const provider = await buildSelectableLiveNvidiaProvider();

    expect(provider.models).toMatchObject([
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        reasoning: true,
        params: { chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true } },
      },
    ]);
    expect(provider.models).toHaveLength(1);
  });

  it("does not turn an empty authoritative inventory into a bundled fallback", async () => {
    mockInventoryAndFeatured({
      ids: [],
      featured: [
        {
          model: "z-ai/glm-5.2",
          "model-name": "Stale featured model",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    expect((await buildLiveNvidiaProvider()).models).toEqual([]);
    expect((await buildSelectableLiveNvidiaProvider()).models).toEqual([]);
  });

  it("does not treat featured rows as fresh inventory when model discovery fails", async () => {
    mockInventoryAndFeatured({
      ids: [],
      inventoryStatus: 503,
      featured: [
        { model: "z-ai/glm-5.2", "model-name": "GLM 5.2", context: 202752, "max-output": 8192 },
      ],
    });

    expect((await buildLiveNvidiaProvider()).models.map((model) => model.id)).toEqual(
      EXPECTED_SELECTABLE_MODELS.map((model) => model.id),
    );
    expect((await buildSelectableLiveNvidiaProvider()).models).toEqual([]);
  });

  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(
      provider.models.map(({ id, name, contextWindow, maxTokens }) => ({
        id,
        name,
        contextWindow,
        maxTokens,
      })),
    ).toEqual(EXPECTED_BUNDLED_MODELS);
    expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
      [],
    );
    expect(
      provider.models
        .slice(0, EXPECTED_SELECTABLE_MODELS.length)
        .map(({ id, input, reasoning }) => ({
          id,
          input,
          reasoning,
        })),
    ).toEqual([
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        input: ["text"],
        reasoning: true,
      },
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        input: ["text"],
        reasoning: true,
      },
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        input: ["text"],
        reasoning: true,
      },
      { id: "z-ai/glm-5.2", input: ["text"], reasoning: true },
      {
        id: "moonshotai/kimi-k2.6",
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "minimaxai/minimax-m3",
        input: ["text", "image"],
        reasoning: true,
      },
      { id: "deepseek-ai/deepseek-v4-pro", input: ["text"], reasoning: true },
    ]);
    expect(provider.models[0]).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      params: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      },
    });
    expect(provider.models[2]).toMatchObject({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 1_000_000,
    });
    expect(
      manifest.modelCatalog.providers.nvidia.models
        .filter((model) => "status" in model && model.status === "deprecated")
        .map((model) =>
          "replacedBy" in model ? { id: model.id, replacedBy: model.replacedBy } : { id: model.id },
        ),
    ).toEqual([
      { id: "qwen/qwen3.5-397b-a17b" },
      { id: "moonshotai/kimi-k2.5", replacedBy: "moonshotai/kimi-k2.6" },
      { id: "z-ai/glm-5.1", replacedBy: "z-ai/glm-5.2" },
      { id: "z-ai/glm5", replacedBy: "z-ai/glm-5.2" },
      { id: "minimaxai/minimax-m2.7", replacedBy: "minimaxai/minimax-m3" },
    ]);
    expect(provider.models.find((model) => model.id === "moonshotai/kimi-k2.5")).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
    });
    expect(provider.models.find((model) => model.id === "minimaxai/minimax-m2.7")).toMatchObject({
      input: ["text"],
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 16_384,
    });
  });

  it("keeps deprecated exact-reference rows out of the selectable catalog", () => {
    const provider = buildSelectableNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      EXPECTED_SELECTABLE_MODELS.map((model) => model.id),
    );
  });

  it("promotes ranked models from NVIDIA's featured catalog", async () => {
    const release = mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.2",
          "model-name": "GLM 5.2",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super 120B",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.2",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "GLM 5.2",
      contextWindow: 202752,
      maxTokens: 8192,
      compat: { requiresStringContent: true },
    });
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "nvidia-featured-model-catalog",
      init: { headers: expect.any(Headers) },
      lookupFn: expect.any(Function),
      policy: { allowedHostnames: ["assets.ngc.nvidia.com"] },
      signal: undefined,
      timeoutMs: expect.any(Number),
      url: NVIDIA_FEATURED_MODELS_URL,
      requireHttps: true,
    });
    // getCachedLiveProviderModelRows forwards the budget remaining after elapsed
    // time, so only the bound is stable; pinning 10_000 fails once a millisecond passes.
    const guardedRequest = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls.find(
      ([request]) => request.url === NVIDIA_FEATURED_MODELS_URL,
    )?.[0];
    expect(guardedRequest?.timeoutMs).toBeGreaterThan(0);
    expect(guardedRequest?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back to the bundled catalog when live discovery is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      EXPECTED_SELECTABLE_MODELS.map((model) => model.id),
    );
  });

  it("uses only selectable live catalog rows when the featured catalog returns models", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.2",
          "model-name": "GLM 5.2",
          context: 202752,
          "max-output": 8192,
        },
        {
          model: "nemotron-3-super-120b-a12b",
          "model-name": "Nemotron 3 Super 120B",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildSelectableLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "z-ai/glm-5.2",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("restores bundled legacy models when NVIDIA republishes them in its featured catalog", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m3",
          "model-name": "Minimax M3",
          context: 196608,
          "max-output": 8192,
        },
        ...EXPECTED_DEPRECATED_MODELS.map((model) => ({
          model: model.id,
          "model-name": model.name,
          context: model.contextWindow,
          "max-output": model.maxTokens,
        })),
      ],
    });

    const live = await buildLiveNvidiaProvider();
    const selectableLive = await buildSelectableLiveNvidiaProvider();
    const republishedIds = [
      "minimaxai/minimax-m3",
      ...EXPECTED_DEPRECATED_MODELS.map((model) => model.id),
    ];

    expect(live.models.map((model) => model.id)).toEqual(republishedIds);
    expect(selectableLive.models.map((model) => model.id)).toEqual(republishedIds);
  });

  it("maps a republished Qwen model from NVIDIA's current featured catalog", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m3",
          "model-name": "Minimax M3",
          context: 196608,
          "max-output": 8192,
        },
        {
          model: "deepseek-ai/deepseek-v4-pro",
          "model-name": "DeepSeek V4 Pro",
          context: 262144,
          "max-output": 16384,
        },
        {
          model: "qwen/qwen3.5-397b-a17b",
          "model-name": "Qwen3.5 397B A17B",
          context: 262144,
          "max-output": 16384,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(
      provider.models.map(({ id, contextWindow, maxTokens }) => ({
        id,
        contextWindow,
        maxTokens,
      })),
    ).toEqual([
      { id: "minimaxai/minimax-m3", contextWindow: 196_608, maxTokens: 8_192 },
      { id: "deepseek-ai/deepseek-v4-pro", contextWindow: 262_144, maxTokens: 16_384 },
      { id: "qwen/qwen3.5-397b-a17b", contextWindow: 262_144, maxTokens: 16_384 },
    ]);
  });

  it("returns no selectable live rows when live discovery is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildSelectableLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([]);
  });

  it("ignores malformed featured catalog rows and keeps valid entries", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "bad model id",
          "model-name": "Bad",
          context: 1000,
          "max-output": 1000,
        },
        {
          model: "minimaxai/minimax-m3",
          "model-name": "Minimax M3",
          context: 196608,
          "max-output": 8192,
        },
        {
          model: "oversized-context",
          "model-name": "Oversized Context",
          context: 10_000_001,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m3"]);
  });

  it("caches the featured catalog for repeated provider builds", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m3",
          "model-name": "Minimax M3",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });

    await buildLiveNvidiaProvider();
    await buildLiveNvidiaProvider();

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("does not cache successful featured catalog responses with no usable rows", async () => {
    mockFeaturedCatalogResponse(
      {
        "featured-models": [
          {
            model: "bad model id",
            "model-name": "Bad",
            context: 1000,
            "max-output": 1000,
          },
        ],
      },
      200,
      ["z-ai/glm-5.2"],
    );
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.2",
          "model-name": "Updated GLM 5.2",
          context: 262144,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models).toMatchObject([
      { id: "z-ai/glm-5.2", name: "GLM 5.2", contextWindow: 202752 },
    ]);
    expect(second.models).toMatchObject([
      { id: "z-ai/glm-5.2", name: "Updated GLM 5.2", contextWindow: 262144 },
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
  });

  it("applies bundled Ultra defaults when featured catalog returns Ultra", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "nemotron-3-ultra-550b-a55b",
          "model-name": "Nemotron 3 Ultra 550B",
          context: 1048576,
          "max-output": 8192,
        },
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "minimaxai/minimax-m2.7",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "Nemotron 3 Ultra 550B",
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      params: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true,
        },
      },
    });
  });
});
