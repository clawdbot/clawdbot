import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveNvidiaProvider,
  buildNvidiaProvider,
  buildSelectableLiveNvidiaProvider,
  clearNvidiaFeaturedModelCacheForTests,
  NVIDIA_FEATURED_MODELS_URL,
} from "./provider-catalog.js";

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
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
      [],
    );
  });

  it("promotes ranked models from NVIDIA's featured catalog", async () => {
    const release = mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
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
      "z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
    expect(provider.models[0]).toMatchObject({
      name: "GLM 5.1",
      contextWindow: 202752,
      maxTokens: 8192,
      compat: { requiresStringContent: true },
    });
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: NVIDIA_FEATURED_MODELS_URL,
      timeoutMs: 10_000,
      requireHttps: true,
      policy: { allowedHostnames: ["assets.ngc.nvidia.com"] },
      lookupFn: expect.any(Function),
      auditContext: "nvidia-featured-model-catalog",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back to the bundled catalog when the featured catalog is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);

    const provider = await buildLiveNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
  });

  it("retains shipped NVIDIA model refs as bundled fallback compatibility rows", () => {
    const provider = buildNvidiaProvider();

    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["minimaxai/minimax-m2.5", "z-ai/glm5"]),
    );
  });

  it("uses only selectable live catalog rows when the featured catalog returns models", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
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
      "z-ai/glm-5.1",
      "nvidia/nemotron-3-super-120b-a12b",
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
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
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

    expect(provider.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m2.7"]);
  });

  it("caches the featured catalog for repeated provider builds", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
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
          model: "minimaxai/minimax-m2.7",
          "model-name": "Minimax M2.7",
          context: 196608,
          "max-output": 8192,
        },
      ],
    });
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "z-ai/glm-5.1",
          "model-name": "GLM 5.1",
          context: 202752,
          "max-output": 8192,
        },
      ],
    });

    const first = await buildLiveNvidiaProvider();
    const second = await buildLiveNvidiaProvider();

    expect(first.models.map((model) => model.id)).toEqual(["minimaxai/minimax-m2.7"]);
    expect(second.models.map((model) => model.id)).toEqual(["z-ai/glm-5.1"]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });
});
