import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

function createFetchFixture(payload: unknown): typeof fetch {
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("scanOpenRouterModels", () => {
  it("lists free models without probing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/free-by-pricing",
          name: "Free By Pricing",
          context_length: 16_384,
          max_completion_tokens: 1024,
          supported_parameters: ["tools", "tool_choice", "temperature"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
        {
          id: "acme/free-by-suffix:free",
          name: "Free By Suffix",
          context_length: 8_192,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "acme/paid",
          name: "Paid",
          context_length: 4_096,
          supported_parameters: ["tools"],
          modality: "text",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    const [byPricing] = results;
    expect(byPricing).toBeTruthy();
    if (!byPricing) {
      throw new Error("Expected pricing-based model result.");
    }
    expect(byPricing.supportsToolsMeta).toBe(true);
    expect(byPricing.supportedParametersCount).toBe(3);
    expect(byPricing.isFree).toBe(true);
    expect(byPricing.tool.skipped).toBe(true);
    expect(byPricing.image.skipped).toBe(true);
  });

  it("requires an API key when probing", async () => {
    const fetchImpl = createFetchFixture({ data: [] });
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(
        scanOpenRouterModels({
          fetchImpl,
          probe: true,
          apiKey: "",
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    });
  });

  it("applies the scan timeout to the OpenRouter catalog request", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = typeof init === "object" && init ? init.signal : undefined;
        if (signal?.aborted) {
          reject(new Error("catalog aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("catalog aborted")), {
          once: true,
        });
      });

    await expect(
      scanOpenRouterModels({
        fetchImpl,
        probe: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/catalog aborted/);
  });

  it("matches provider filters across canonical provider aliases", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "z.ai/glm-5",
          name: "GLM-5",
          context_length: 128_000,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          context_length: 128_000,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
      providerFilter: "z-ai",
    });

    expect(results.map((entry) => entry.id)).toEqual(["z.ai/glm-5"]);
  });
});
