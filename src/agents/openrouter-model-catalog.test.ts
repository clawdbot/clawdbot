import { describe, expect, it } from "vitest";
import {
  OPENROUTER_MODELS_URL,
  buildOpenRouterCatalog,
  normalizeOpenRouterModel,
} from "./openrouter-model-catalog.js";

describe("OpenRouter model catalog", () => {
  it("normalizes a free coding/tool model", () => {
    const result = normalizeOpenRouterModel({
      id: "example/coder:free",
      name: "Example Coder",
      description: "A coding and agentic model",
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0" },
      top_provider: { context_length: 131072 },
      supported_parameters: ["tools", "tool_choice", "reasoning", "structured_outputs"],
    });

    expect(result?.candidate.free).toBe(true);
    expect(result?.candidate.supportsTools).toBe(true);
    expect(result?.candidate.contextWindow).toBe(131072);
    expect(result?.candidate.capabilities.coding).toBeGreaterThan(0.9);
    expect(result?.candidate.capabilities["tool-use"]).toBeGreaterThan(0.9);
    expect(result?.candidate.capabilities["long-context"]).toBeGreaterThan(0.9);
  });

  it("does not mark a paid model as free", () => {
    const result = normalizeOpenRouterModel({
      id: "example/general",
      name: "Example General",
      pricing: { prompt: "0.000001", completion: "0.000002" },
    });

    expect(result?.candidate.free).toBe(false);
  });

  it("uses the public models endpoint and normalizes the complete response", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(OPENROUTER_MODELS_URL);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "example/free:free",
              name: "Free Example",
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "example/paid",
              name: "Paid Example",
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const catalog = await buildOpenRouterCatalog({ fetch: fetchMock });
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.candidates.filter((item) => item.free)).toHaveLength(1);
  });

  it("rejects malformed catalog payloads", async () => {
    const fetchMock = async () => new Response(JSON.stringify({ data: {} }), { status: 200 });
    await expect(buildOpenRouterCatalog({ fetch: fetchMock })).rejects.toThrow("missing data[]");
  });
});
