// Nvidia tests cover provider catalog plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildLiveNvidiaProvider,
  buildNvidiaProvider,
  buildSelectableNvidiaProvider,
  buildSelectableLiveNvidiaProvider,
  clearNvidiaFeaturedModelCacheForTests,
  NVIDIA_FEATURED_MODELS_URL,
} from "./provider-catalog.js";

const EXPECTED_FEATURED_MODELS = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron 3 Ultra 550B",
    contextWindow: 1_048_576,
    maxTokens: 8_192,
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
    maxTokens: 8_192,
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
  {
    id: "qwen/qwen3.5-397b-a17b",
    name: "Qwen3.5 397B A17B",
    contextWindow: 262_144,
    maxTokens: 16_384,
  },
] as const;

const EXPECTED_DEPRECATED_MODELS = [
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 262_144,
    maxTokens: 8_192,
  },
  {
    id: "z-ai/glm-5.1",
    name: "GLM 5.1",
    contextWindow: 202_752,
    maxTokens: 8_192,
  },
  {
    id: "minimaxai/minimax-m2.5",
    name: "MiniMax M2.5",
    contextWindow: 196_608,
    maxTokens: 8_192,
  },
  { id: "z-ai/glm5", name: "GLM-5", contextWindow: 202_752, maxTokens: 8_192 },
  {
    id: "minimaxai/minimax-m2.7",
    name: "Minimax M2.7",
    contextWindow: 196_608,
    maxTokens: 8_192,
  },
] as const;

const EXPECTED_BUNDLED_MODELS = [
  ...EXPECTED_FEATURED_MODELS,
  ...EXPECTED_DEPRECATED_MODELS,
] as const;

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

afterEach(() => {
  vi.useRealTimers();
  clearNvidiaFeaturedModelCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200) {
  const release = vi.fn();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: Response.json(payload, { status }),
    finalUrl: NVIDIA_FEATURED_MODELS_URL,
    release,
  });
  return release;
}

describe("nvidia provider catalog", () => {
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
    expect(provider.models[1]).toMatchObject({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 1_000_000,
    });
    expect(
      manifest.modelCatalog.providers.nvidia.models
        .filter((model) => "status" in model && model.status === "deprecated")
        .map((model) => ({ id: model.id, replacedBy: model.replacedBy })),
    ).toEqual([
      { id: "moonshotai/kimi-k2.5", replacedBy: "moonshotai/kimi-k2.6" },
      { id: "z-ai/glm-5.1", replacedBy: "z-ai/glm-5.2" },
      { id: "minimaxai/minimax-m2.5", replacedBy: "minimaxai/minimax-m3" },
      { id: "z-ai/glm5", replacedBy: "z-ai/glm-5.2" },
      { id: "minimaxai/minimax-m2.7", replacedBy: "minimaxai/minimax-m3" },
    ]);
  });

  it("keeps deprecated exact-reference rows out of the selectable catalog", () => {
    const provider = buildSelectableNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      EXPECTED_FEATURED_MODELS.map((model) => model.id),
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
      timeoutMs: 10_000,
      url: NVIDIA_FEATURED_MODELS_URL,
      requireHttps: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back to the bundled catalog when the featured catalog is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      EXPECTED_FEATURED_MODELS.map((model) => model.id),
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

  it("keeps every deprecated exact-reference row out of live catalogs", async () => {
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

    expect(live.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m3"]);
    expect(selectableLive.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m3"]);
  });

  it("maps current featured feed metadata for MiniMax, DeepSeek, and Qwen", async () => {
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

  it("returns no selectable live rows when the featured catalog is unavailable", async () => {
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

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });

  it("skips featured catalog cache when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));
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
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.2",
          "model-name": "GLM 5.2",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m3"]);
    expect(second.models.map((model) => model.id)).toEqual(["z-ai/glm-5.2"]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("does not cache successful featured catalog responses with no usable rows", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "bad model id",
          "model-name": "Bad",
          context: 1000,
          "max-output": 1000,
        },
      ],
    });
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.2",
          "model-name": "GLM 5.2",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models.map((model) => model.id)).toEqual(
      EXPECTED_FEATURED_MODELS.map((model) => model.id),
    );
    expect(second.models.map((model) => model.id)).toEqual(["z-ai/glm-5.2"]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
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

    expect(provider.models.map((model) => model.id)).toEqual(["nvidia/nemotron-3-ultra-550b-a55b"]);
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
