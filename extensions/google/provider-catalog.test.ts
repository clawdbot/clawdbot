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
        "gemini-3.7-flash",
      ]),
    );
    expect(provider.models.find((model) => model.id === "gemini-3.7-flash")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { minimal: null },
    });
    expect(provider.models.find((model) => model.id === "gemini-3.6-flash")).not.toHaveProperty(
      "thinkingLevelMap",
    );
  });

  it("keeps Google AI Studio and Vertex model ids aligned", () => {
    expect(buildGoogleVertexStaticCatalogProvider().models.map((model) => model.id)).toEqual(
      buildGoogleStaticCatalogProvider().models.map((model) => model.id),
    );
    expect(buildGoogleStaticCatalogProvider().models[0]?.input).toEqual(["text", "image", "video"]);
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
                    name: "models/gemini-3.7-flash",
                    displayName: "Gemini 3.7 Flash",
                    inputTokenLimit: 1_048_576,
                    outputTokenLimit: 65_536,
                    supportedGenerationMethods: ["generateContent"],
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
        input: ["text", "image", "video"],
        compat: { codeMode: "preferred" },
      }),
      expect.objectContaining({
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        input: ["text", "image", "video"],
        compat: { codeMode: "preferred" },
      }),
      expect.objectContaining({
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        input: ["text", "image", "video"],
        compat: { codeMode: "preferred" },
        thinkingLevelMap: { minimal: null },
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
    expect(
      provider.models
        .filter((model) => model.id.startsWith("gemma-"))
        .every((model) => model.compat === undefined),
    ).toBe(true);
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

  it("propagates static compat to discovered id variants of the same weights", async () => {
    const cases: ReadonlyArray<{ id: string; compat: { codeMode: string } | undefined }> = [
      { id: "gemini-3.5-flash", compat: { codeMode: "preferred" } },
      { id: "gemini-3.5-flash-preview-06-17", compat: { codeMode: "preferred" } },
      { id: "gemini-3.1-pro-preview-05-06", compat: { codeMode: "preferred" } },
      { id: "gemini-flash-latest", compat: { codeMode: "preferred" } },
      { id: "gemini-flash-lite-latest", compat: { codeMode: "preferred" } },
      { id: "gemini-pro-latest", compat: { codeMode: "preferred" } },
      // Dated variant of unflagged weights resolves but carries no compat.
      { id: "gemini-2.5-flash-preview-05-20", compat: undefined },
      // Unknown family member fails closed: no static entry, no compat.
      { id: "gemini-3.9-flash", compat: undefined },
    ];
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: Response.json({
        models: cases.map(({ id }) => ({
          name: `models/${id}`,
          displayName: id,
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ["generateContent"],
          thinking: true,
        })),
      }),
      finalUrl: url,
      release: async () => undefined,
    }));

    const provider = await buildGoogleLiveCatalogProvider({
      apiKey: "GEMINI_API_KEY",
      fetchGuard,
    });

    for (const { id, compat } of cases) {
      const model = provider.models.find((entry) => entry.id === id);
      expect(model, id).toBeDefined();
      expect(model?.compat, id).toEqual(compat);
    }
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
