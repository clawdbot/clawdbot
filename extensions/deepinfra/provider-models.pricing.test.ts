import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraProvider } from "./api.js";
import { DEEPINFRA_MODEL_CATALOG, discoverDeepInfraModels } from "./provider-models.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";
const jsonResponse = Response.json.bind(Response);

function makeAgentModelEntry({ id }: { id: string }) {
  return {
    id,
    metadata: {
      tags: ["chat", "vlm", "reasoning"],
      context_length: 131072,
      max_tokens: 65536,
      pricing: { input_tokens: 3, output_tokens: 15, cache_read_tokens: 0.3 },
    },
  };
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function withFetchPathTest(mockFetch: ReturnType<typeof vi.fn>, run: () => Promise<void>) {
  vi.stubGlobal("fetch", mockFetch);
  await run();
}

describe("DeepInfra native runtime prices", () => {
  it.each([
    { metadata: 503, pricing: 503, empty: false },
    { metadata: 503, pricing: 200, empty: false },
    { metadata: 200, pricing: 503, empty: false },
    { metadata: 200, pricing: 200, empty: true },
  ])("keeps the public builder advisory for $metadata/$pricing empty=$empty", async (scenario) => {
    const mockFetch = vi.fn(async (url: string) => {
      const metadata = url === DEEPINFRA_MODELS_URL;
      const status = metadata ? scenario.metadata : scenario.pricing;
      if (status !== 200) {
        return new Response("unavailable", { status });
      }
      return jsonResponse(
        metadata
          ? { data: scenario.empty ? [] : [makeAgentModelEntry({ id: "fixture/public-model" })] }
          : [
              {
                model_name: "fixture/public-model",
                pricing: {
                  type: "tokens",
                  cents_per_input_token: 0.0002,
                  cents_per_output_token: 0.001,
                },
              },
            ],
      );
    });
    await withFetchPathTest(mockFetch, async () => {
      const provider = await buildDeepInfraProvider({ hasApiKey: true });
      expect(provider.models.map((model) => model.id)).toEqual(
        expect.arrayContaining(DEEPINFRA_MODEL_CATALOG.map((model) => model.id)),
      );
      if (scenario.metadata === 200 && !scenario.empty) {
        expect(provider.models.find((model) => model.id === "fixture/public-model")?.cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
    });
  });

  it("rejects failed metadata even when native pricing succeeds", async () => {
    const seedId = DEEPINFRA_MODEL_CATALOG[0]!.id;
    const mockFetch = vi.fn(async (url: string) => {
      if (url === DEEPINFRA_MODELS_URL) {
        return new Response("unavailable", { status: 503 });
      }
      expect(url).toBe("https://api.deepinfra.com/models/list");
      return jsonResponse(
        [seedId, "fixture/price-only"].map((model_name) => ({
          model_name,
          pricing: {
            type: "tokens",
            cents_per_input_token: 0.0002,
            cents_per_output_token: 0.001,
            discount: 0.5,
            rate_per_input_token_cached: 0.2,
          },
        })),
      );
    });
    await withFetchPathTest(mockFetch, async () => {
      await discoverDeepInfraModels({ hasApiKey: false });
      expect(mockFetch).not.toHaveBeenCalled();
      await expect(discoverDeepInfraModels({ hasApiKey: true })).rejects.toThrow("HTTP 503");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["unavailable", "malformed", "absent"])(
    "rejects %s native pricing and recovers without refetching metadata",
    async (failure) => {
      let nativeCalls = 0;
      const mockFetch = vi.fn(async (url: string) => {
        if (url === DEEPINFRA_MODELS_URL) {
          return jsonResponse({ data: [makeAgentModelEntry({ id: "fixture/recovered" })] });
        }
        expect(url).toBe("https://api.deepinfra.com/models/list");
        nativeCalls++;
        if (nativeCalls === 1) {
          if (failure === "unavailable") {
            return new Response("unavailable", { status: 503 });
          }
          if (failure === "absent") {
            return jsonResponse([]);
          }
          return jsonResponse([
            {
              model_name: "fixture/recovered",
              pricing: {
                type: "tokens",
                cents_per_input_token: -1,
                cents_per_output_token: 0.001,
              },
            },
          ]);
        }
        return jsonResponse([
          {
            model_name: "fixture/recovered",
            pricing: {
              type: "tokens",
              cents_per_input_token: 0.0002,
              cents_per_output_token: 0.001,
            },
          },
        ]);
      });
      await withFetchPathTest(mockFetch, async () => {
        await expect(discoverDeepInfraModels({ hasApiKey: true })).rejects.toThrow(
          failure === "unavailable"
            ? "HTTP 503"
            : "Native DeepInfra pricing is malformed or has no usable schedules",
        );
        const recovered = await discoverDeepInfraModels({ hasApiKey: true });
        expect(recovered[0]?.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
        expect(recovered.map((model) => model.id)).toEqual(["fixture/recovered"]);
        expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(recovered);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });
    },
  );

  it("uses native DeepInfra discounts and omits qualified prices without changing metadata", async () => {
    const nativePricing = {
      type: "tokens",
      cents_per_input_token: 0.0002,
      cents_per_output_token: 0.001,
      rate_per_input_token_cached: 0.2,
      discount: 0.5,
      discount_ends_at: null,
    };
    const mockFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === DEEPINFRA_MODELS_URL) {
        return jsonResponse({
          data: ["fixture/paid", "fixture/qualified", "fixture/absent"].map((id) =>
            makeAgentModelEntry({ id }),
          ),
        });
      }
      expect(url).toBe("https://api.deepinfra.com/models/list");
      return jsonResponse([
        { model_name: "fixture/paid", pricing: nativePricing },
        {
          model_name: "fixture/qualified",
          pricing: { ...nativePricing, full: "Higher rates above a context threshold" },
        },
        { model_name: DEEPINFRA_MODEL_CATALOG[0]!.id, pricing: nativePricing },
      ]);
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels({ hasApiKey: true });
      expect(models.slice(0, 3).map((model) => model.id)).toEqual([
        "fixture/paid",
        "fixture/qualified",
        "fixture/absent",
      ]);
      expect(models[0]).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 131072,
        maxTokens: 65536,
        cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0 },
      });
      for (const model of models) {
        expect(model.cost).toEqual(
          model.id === "fixture/paid" || model.id === DEEPINFRA_MODEL_CATALOG[0]!.id
            ? { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0 }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        );
      }
      expect(await discoverDeepInfraModels({ hasApiKey: true })).toEqual(models);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [, init] of mockFetch.mock.calls) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
      }
    });
  });
});
