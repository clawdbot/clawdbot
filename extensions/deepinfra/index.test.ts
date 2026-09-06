// Deepinfra tests cover index plugin behavior.
import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

function buildDeepInfraCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    agentDir: "/tmp/openclaw-agent",
    resolveProviderApiKey: () => ({ apiKey: "profile-key" }),
    resolveProviderAuth: () => ({
      apiKey: "profile-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function makeAgentModelEntry(id = "profile/live-model") {
  return {
    id,
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: id,
      context_length: 32768,
      max_tokens: 4096,
      pricing: { input_tokens: 1, output_tokens: 2 },
      tags: ["chat"],
    },
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mockDiscoveryFetch(id = "profile/live-model") {
  return vi.fn(async (url: string) => {
    if (url === DEEPINFRA_MODELS_URL) {
      return jsonResponse({ data: [makeAgentModelEntry(id)] });
    }
    expect(url).toBe("https://api.deepinfra.com/models/list");
    return jsonResponse([
      {
        model_name: id,
        pricing: {
          type: "tokens",
          cents_per_input_token: 0.0004,
          cents_per_output_token: 0.0008,
        },
      },
    ]);
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

async function withLiveDiscoveryTestEnv(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("deepinfra capability registration", () => {
  it.each([
    ...["metadata", "pricing"].flatMap((scenario) =>
      [401, 403, 503].map((status) => ({ scenario, status })),
    ),
    ...[200, 401, 503].map((status) => ({ scenario: "empty", status })),
  ])(
    "reports public $scenario HTTP $status without rejecting inference credentials",
    async ({ scenario, status }) => {
      const healthyFetch = mockDiscoveryFetch();
      const mockFetch = vi.fn(async (url: string) => {
        const metadata = url === DEEPINFRA_MODELS_URL;
        if (scenario === "empty" && metadata) {
          return jsonResponse({ data: [] });
        }
        if (
          (scenario === "metadata" && metadata) ||
          (scenario === "pricing" && !metadata) ||
          (scenario === "empty" && !metadata && status !== 200)
        ) {
          return new Response("unavailable", { status });
        }
        return healthyFetch(url);
      });
      const provider = await registerSingleProviderPlugin(deepinfraPlugin);
      await withLiveDiscoveryTestEnv(mockFetch, async () => {
        const result = await provider.catalog?.run(buildDeepInfraCatalogContext());
        const rejected = status === 401 || status === 403;
        expect(result).toEqual(
          scenario === "empty"
            ? {
                provider: {
                  baseUrl: "https://api.deepinfra.com/v1/openai",
                  api: "openai-completions",
                  apiKey: "profile-key",
                  models: [],
                },
                outcomes: [{ provider: "deepinfra", status: "ready" }],
              }
            : {
                providers: {},
                outcomes: [
                  {
                    provider: "deepinfra",
                    status: rejected ? "auth-rejected" : "unavailable",
                    ...(rejected ? { rejectionScope: "catalog" } : {}),
                  },
                ],
              },
        );
      });
    },
  );

  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.embeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });

  it("uses profile-resolved API keys for live text catalog discovery", async () => {
    clearLiveCatalogCacheForTests();
    const mockFetch = mockDiscoveryFetch();
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);
    const provider = captured.providers[0];
    if (!provider?.catalog) {
      throw new Error("expected DeepInfra provider registration");
    }
    const catalog = provider.catalog;

    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const result = await catalog.run(buildDeepInfraCatalogContext());
      if (!result || !("provider" in result)) {
        throw new Error("expected single-provider DeepInfra catalog result");
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(
        expect.arrayContaining([DEEPINFRA_MODELS_URL, "https://api.deepinfra.com/models/list"]),
      );
      expect(result.provider.models[0]?.cost).toEqual({
        input: 4,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result?.provider.apiKey).toBe("profile-key");
      expect(result.outcomes).toEqual([{ provider: "deepinfra", status: "ready" }]);
      expect(result.provider.models.map((model) => model.id)).toEqual(["profile/live-model"]);
    });
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});
