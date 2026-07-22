import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterLiveProvider, buildOpenrouterProvider } from "./provider-catalog.js";

describe("OpenRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("discovers text models and preserves bundled routes", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        data: [
          {
            id: "google/gemini-3.6-flash",
            name: "Google: Gemini 3.6 Flash",
            architecture: {
              input_modalities: ["text", "image", "audio", "video"],
              output_modalities: ["text"],
            },
            supported_parameters: ["reasoning", "tools"],
            context_length: 1_048_576,
            top_provider: {
              context_length: 1_048_576,
              max_completion_tokens: 65_536,
            },
            pricing: {
              prompt: "0.0000015",
              completion: "0.0000075",
              input_cache_read: "0.00000015",
            },
          },
          {
            id: "google/gemini-3.5-flash-lite",
            architecture: { modality: "text+image->text" },
            supported_parameters: ["include_reasoning"],
            context_length: 1_048_576,
            max_completion_tokens: 65_536,
            pricing: { prompt: "0.0000003", completion: "0.0000025" },
          },
          {
            id: "google/gemini-3.1-flash-image",
            architecture: { modality: "text+image->image" },
            context_length: 65_536,
          },
        ],
      }),
      finalUrl: url,
      release,
    }));

    const provider = await buildOpenrouterLiveProvider({
      apiKey: "OPENROUTER_API_KEY",
      discoveryApiKey: "resolved-openrouter-key",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("OPENROUTER_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "openrouter/auto",
        "google/gemini-3.5-flash-lite",
        "google/gemini-3.6-flash",
      ]),
    );
    expect(provider.models.map((model) => model.id)).not.toContain("google/gemini-3.1-flash-image");
    expect(provider.models.find((model) => model.id === "google/gemini-3.6-flash")).toMatchObject({
      name: "Google: Gemini 3.6 Flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
    });
    expect(
      new Headers(vi.mocked(fetchGuard).mock.calls[0]?.[0].init?.headers).get("authorization"),
    ).toBe("Bearer resolved-openrouter-key");
    expect(release).toHaveBeenCalledOnce();
  });

  it("caches live discovery and falls back to bundled rows", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        data: [
          {
            id: "google/gemini-3.6-flash",
            architecture: { modality: "text->text" },
          },
        ],
      }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await buildOpenrouterLiveProvider({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    await buildOpenrouterLiveProvider({
      apiKey: "runtime-b",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    expect(fetchGuard).toHaveBeenCalledOnce();

    clearLiveCatalogCacheForTests();
    vi.mocked(fetchGuard).mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpenrouterLiveProvider({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    expect(fallback.models).toEqual(buildOpenrouterProvider().models);
  });
});
