// LLMTR tests cover plugin registration and model discovery filtering.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCachedLiveProviderModelRows = vi.fn();

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async () => {
  // Keep the real LiveModelCatalogHttpError: models.ts branches on `instanceof`.
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")
  >("openclaw/plugin-sdk/provider-catalog-live-runtime");
  return { ...actual, getCachedLiveProviderModelRows };
});

const { discoverLlmtrModels, LLMTR_BASE_URL } = await import("./models.js");
const plugin = (await import("./index.js")).default;

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

function modelRow(id: string, operations: string[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "model",
    owned_by: id.split("/")[0],
    supported_operations: operations,
    ...overrides,
  };
}

describe("llmtr provider plugin", () => {
  beforeEach(() => {
    getCachedLiveProviderModelRows.mockReset();
  });

  it("registers LLMTR as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("llmtr");
    expect(provider.envVars).toEqual(["LLMTR_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe(LLMTR_BASE_URL);

    const ids = catalogProvider.models?.map((model) => model.id) ?? [];
    // The catalog ships Turkey-hosted routes plus the global passthrough
    // selection. Turkey-hosted routes are literally `llmtr/<name>` upstream, so
    // the vendor prefix must survive normalization even though it repeats the
    // provider id (`modelKey` collapses the ref back to
    // `llmtr/trendyol-asure-12b`).
    expect(ids).toContain("llmtr/trendyol-asure-12b");
    expect(ids).toContain("anthropic/claude-sonnet-5");
    expect(ids).toContain("zai/glm-5.2");
    expect(ids).toContain("minimax/minimax-m3");
    // Both dropped out of GET /v1/models upstream; trendyol-asure-12b replaces
    // trendyol-7b.
    expect(ids).not.toContain("llmtr/sincap");
    expect(ids).not.toContain("llmtr/trendyol-7b");
    // Non-chat routes must never reach the catalog.
    expect(ids).not.toContain("llmtr/embeddinggemma-300m");
  });

  it("drops discovered models that cannot serve chat completions", async () => {
    getCachedLiveProviderModelRows.mockResolvedValue([
      modelRow("llmtr/trendyol-asure-12b", ["CHAT_COMPLETIONS"]),
      modelRow("openai/gpt-5.5", ["RESPONSES"]),
      modelRow("llmtr/embeddinggemma-300m", ["EMBEDDINGS"]),
      modelRow("voyageai/voyage-3.5", ["EMBEDDINGS"]),
      modelRow("recraft/recraft-v3", ["IMAGES"]),
      modelRow("google/gemini-3.5-flash", ["CHAT_COMPLETIONS", "RESPONSES"]),
    ]);

    const ids = (await discoverLlmtrModels("key")).map((model) => model.id);

    expect(ids).toEqual(["llmtr/trendyol-asure-12b", "google/gemini-3.5-flash"]);
  });

  it("builds discovered models from the metadata the gateway publishes", async () => {
    getCachedLiveProviderModelRows.mockResolvedValue([
      modelRow("zai/glm-5.2", ["CHAT_COMPLETIONS"], {
        name: "GLM-5.2",
        context_length: 1000000,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ["text"] },
        pricing: { prompt: "0.00000126", completion: "0.00000396" },
        supported_parameters: ["reasoning", "reasoning_effort", "tools"],
      }),
      modelRow("minimax/minimax-m3", ["CHAT_COMPLETIONS"], {
        context_length: 1000000,
        // Output caps above the window would let the request exceed it.
        top_provider: { max_completion_tokens: 2000000 },
        architecture: { input_modalities: ["text", "image", "file", "video"] },
        supported_parameters: ["tools"],
      }),
      modelRow("acme/unknown", ["CHAT_COMPLETIONS"]),
    ]);

    const models = await discoverLlmtrModels("key");
    const glm = models.find((model) => model.id === "zai/glm-5.2");
    const minimax = models.find((model) => model.id === "minimax/minimax-m3");
    const bare = models.find((model) => model.id === "acme/unknown");

    expect(glm?.name).toBe("GLM-5.2");
    expect(glm?.contextWindow).toBe(1000000);
    expect(glm?.maxTokens).toBe(131072);
    expect(glm?.reasoning).toBe(true);
    // `pricing` is USD per token; catalog cost is USD per million tokens.
    expect(glm?.cost.input).toBe(1.26);
    expect(glm?.cost.output).toBe(3.96);

    // `file` is not an OpenClaw modality, and maxTokens is clamped to the window.
    expect(minimax?.input).toEqual(["text", "image", "video"]);
    expect(minimax?.maxTokens).toBe(1000000);
    expect(minimax?.reasoning).toBe(false);

    // A row without metadata still lands on conservative defaults.
    expect(bare?.contextWindow).toBe(32768);
    expect(bare?.maxTokens).toBe(8192);
    expect(bare?.input).toEqual(["text"]);

    // LLMTR returns usage on streamed responses; every path must carry the flag.
    for (const model of models) {
      expect(model.compat?.supportsUsageInStreaming).toBe(true);
    }
  });

  it("falls back to the bundled catalog when discovery fails", async () => {
    getCachedLiveProviderModelRows.mockRejectedValue(new Error("network down"));

    const ids = (await discoverLlmtrModels()).map((model) => model.id);

    expect(ids).toContain("llmtr/trendyol-asure-12b");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });
});
