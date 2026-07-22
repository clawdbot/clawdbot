// Google tests cover provider catalog plugin behavior.
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleLiveCatalogProvider,
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";

describe("google provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("registers current Gemini rows for the Google Vertex provider", () => {
    const provider = buildGoogleVertexStaticCatalogProvider();

    expect(provider.api).toBe("google-vertex");
    expect(provider.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "gemini-2.5-pro",
        "gemini-3.1-pro-preview",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
      ]),
    );
    expect(provider.models.find((model) => model.id === "gemini-3.6-flash")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
    });
  });

  it("keeps Google AI Studio and Vertex model ids aligned", () => {
    expect(buildGoogleVertexStaticCatalogProvider().models.map((model) => model.id)).toEqual(
      buildGoogleStaticCatalogProvider().models.map((model) => model.id),
    );
  });

  it("builds the authenticated text catalog from Google models.list metadata", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => {
      const isSecondPage = new URL(url).searchParams.get("pageToken") === "page-2";
      return {
        response: Response.json(
          isSecondPage
            ? {
                models: [
                  {
                    name: "models/gemini-3.5-flash-lite",
                    displayName: "Gemini 3.5 Flash-Lite",
                    inputTokenLimit: 1_048_576,
                    outputTokenLimit: 65_536,
                    supportedGenerationMethods: ["generateContent"],
                    thinking: true,
                  },
                  {
                    name: "models/gemma-3-4b-it",
                    displayName: "Gemma 3 4B",
                    inputTokenLimit: 131_072,
                    outputTokenLimit: 8_192,
                    supportedGenerationMethods: ["generateContent"],
                  },
                ],
              }
            : {
                models: [
                  {
                    name: "models/gemini-3.6-flash",
                    displayName: "Gemini 3.6 Flash",
                    inputTokenLimit: 1_048_576,
                    outputTokenLimit: 65_536,
                    supportedGenerationMethods: ["generateContent", "countTokens"],
                    thinking: true,
                  },
                  {
                    name: "models/gemma-3-1b-it",
                    displayName: "Gemma 3 1B",
                    inputTokenLimit: 32_768,
                    outputTokenLimit: 8_192,
                    supportedGenerationMethods: ["generateContent"],
                  },
                  {
                    name: "models/gemini-3.1-flash-image",
                    displayName: "Nano Banana 2",
                    inputTokenLimit: 65_536,
                    outputTokenLimit: 32_768,
                    supportedGenerationMethods: ["generateContent"],
                  },
                  {
                    name: "models/gemini-embedding-2-preview",
                    displayName: "Gemini Embedding 2",
                    inputTokenLimit: 8_192,
                    outputTokenLimit: 8_192,
                    supportedGenerationMethods: ["embedContent"],
                  },
                ],
                nextPageToken: "page-2",
              },
        ),
        finalUrl: url,
        release,
      };
    });

    const provider = await buildGoogleLiveCatalogProvider({
      apiKey: "GEMINI_API_KEY",
      discoveryApiKey: "resolved-google-key",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("GEMINI_API_KEY");
    expect(provider.models).toEqual([
      expect.objectContaining({
        id: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        input: ["text", "image"],
      }),
      expect.objectContaining({
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        input: ["text", "image"],
      }),
      expect.objectContaining({
        id: "gemma-3-1b-it",
        name: "Gemma 3 1B",
        input: ["text"],
      }),
      expect.objectContaining({
        id: "gemma-3-4b-it",
        name: "Gemma 3 4B",
        input: ["text", "image"],
      }),
    ]);
    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(request?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    expect(new Headers(request?.init?.headers).get("x-goog-api-key")).toBe("resolved-google-key");
    expect(vi.mocked(fetchGuard).mock.calls[1]?.[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2",
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("falls back to bundled rows when live discovery is unusable", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({ models: [{ name: "models/gemini-3.6-flash" }] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    const provider = await buildGoogleLiveCatalogProvider({
      apiKey: "GEMINI_API_KEY",
      discoveryApiKey: "resolved-google-key",
      fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).toEqual(
      buildGoogleStaticCatalogProvider().models.map((model) => model.id),
    );
  });
});
