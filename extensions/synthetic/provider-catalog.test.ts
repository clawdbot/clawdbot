import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { SYNTHETIC_BASE_URL } from "./models.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const fetchGuard = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

const endpoint = "https://api.synthetic.new/openai/v1/models";
const liveModel = {
  id: "hf:Qwen/Qwen3.8-27B",
  name: "Qwen/Qwen3.8-27B",
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  context_length: 262144,
  max_output_length: 65536,
  supported_features: ["tools", "reasoning"],
  reasoning_parameters: { efforts: ["low", "medium", "xhigh"] },
  pricing: {
    prompt: "$0.00000045",
    completion: "$0.0000022",
    input_cache_reads: "$0.00000009",
    input_cache_writes: "0",
  },
};

function context(config: ProviderCatalogContext["config"] = {}): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: "SYNTHETIC_API_KEY",
      discoveryApiKey: "fixture-discovery-key",
    }),
    resolveProviderAuth: () => ({
      apiKey: "SYNTHETIC_API_KEY",
      discoveryApiKey: "fixture-discovery-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function respond(data: unknown[]) {
  fetchGuard.mockResolvedValueOnce({
    response: Response.json({ data }),
    finalUrl: endpoint,
    release: vi.fn(),
  });
}

afterEach(() => {
  fetchGuard.mockReset();
  clearLiveCatalogCacheForTests();
});

describe("Synthetic live catalog", () => {
  it("discovers new models and refreshes known metadata without changing the inference transport", async () => {
    respond([
      liveModel,
      { ...liveModel, id: "hf:moonshotai/Kimi-K3", context_length: 524288 },
      { ...liveModel, id: "hf:zai-org/GLM-5.2", input_modalities: ["text"] },
      {
        ...liveModel,
        id: "syn:small:vision",
        max_output_length: undefined,
        supported_features: undefined,
        reasoning_parameters: { efforts: ["none"] },
      },
      liveModel,
      { ...liveModel, id: "embedding-model", output_modalities: ["embedding"] },
      { ...liveModel, id: "invalid-limits", context_length: -1 },
      { ...liveModel, id: "retired-model", deprecated: true },
    ]);
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run(context());
    if (!result || !("provider" in result)) {
      throw new Error("expected Synthetic catalog");
    }
    expect(result.provider).toMatchObject({
      api: "anthropic-messages",
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey: "SYNTHETIC_API_KEY",
    });
    expect(result.provider.models.map((model) => model.id).toSorted()).toEqual(
      [liveModel.id, "hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2", "syn:small:vision"].toSorted(),
    );
    expect(result.provider.models.find((model) => model.id === liveModel.id)).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 0.45, output: 2.2, cacheRead: 0.09, cacheWrite: 0 },
      compat: { supportsTools: true },
    });
    expect(result.provider.models.find((model) => model.id === "hf:zai-org/GLM-5.2")).toMatchObject(
      {
        input: ["text"],
        contextWindow: 262144,
        maxTokens: 65536,
      },
    );
    expect(result.provider.models.find((model) => model.id === "syn:small:vision")).toMatchObject({
      reasoning: false,
      input: ["text", "image"],
      maxTokens: 8192,
    });
    const request = fetchGuard.mock.calls[0]?.[0];
    expect(request.url).toBe(endpoint);
    expect(new Headers(request.init.headers).get("authorization")).toBe(
      "Bearer fixture-discovery-key",
    );
  });

  it.each(["failure", "empty", "unusable"])(
    "does not substitute seeds for %s discovery",
    async (mode) => {
      if (mode === "failure") {
        fetchGuard.mockRejectedValueOnce(new Error("fixture unavailable"));
      } else {
        respond(mode === "empty" ? [] : [{ id: "missing-metadata" }]);
      }
      const provider = await registerSingleProviderPlugin(plugin);
      await expect(provider.catalog?.run(context())).resolves.toEqual(
        mode === "failure"
          ? {
              providers: {},
              outcomes: [{ provider: "synthetic", status: "unavailable" }],
            }
          : {
              provider: { ...buildSyntheticProvider(), apiKey: "SYNTHETIC_API_KEY", models: [] },
              outcomes: [{ provider: "synthetic", status: "ready" }],
            },
      );
    },
  );

  it("does not send a custom proxy credential to Synthetic's fixed model endpoint", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run(
      context({
        models: {
          providers: {
            synthetic: { baseUrl: "https://proxy.example/anthropic", models: [] },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      provider: { baseUrl: "https://proxy.example/anthropic", api: "anthropic-messages" },
    });
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("keeps static discovery network-free and live discovery credential-gated", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    await expect(provider.staticCatalog?.run(context())).resolves.toEqual({
      provider: buildSyntheticProvider(),
    });
    await expect(
      provider.catalog?.run({ ...context(), resolveProviderApiKey: () => ({ apiKey: undefined }) }),
    ).resolves.toBeNull();
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
