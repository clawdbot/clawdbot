import type { ProviderRequestTransportOverrides } from "openclaw/plugin-sdk/provider-http";
import { describe, expect, it } from "vitest";
import {
  isGoogleGenerativeAiApi,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
  normalizeGoogleProviderConfig,
  parseGeminiAuth,
  resolveGoogleGenerativeAiHttpRequestConfig,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig,
} from "./api.js";

describe("google generative ai helpers", () => {
  it("detects the Google Generative AI transport id", () => {
    expect(isGoogleGenerativeAiApi("google-generative-ai")).toBe(true);
    expect(isGoogleGenerativeAiApi("google-gemini-cli")).toBe(false);
    expect(isGoogleGenerativeAiApi(undefined)).toBe(false);
  });

  it("normalizes only explicit Google Generative AI baseUrls", () => {
    expect(normalizeGoogleGenerativeAiBaseUrl("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://proxy.example.com/google/v1beta")).toBe(
      "https://proxy.example.com/google/v1beta",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://aiplatform.googleapis.com")).toBe(
      "https://aiplatform.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("proxy/generativelanguage.googleapis.com")).toBe(
      "proxy/generativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("generativelanguage.googleapis.com")).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://xgenerativelanguage.googleapis.com")).toBe(
      "https://xgenerativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl()).toBeUndefined();
  });

  it("keeps /openai on generic Google base URL normalization and strips it only for native Gemini callers", () => {
    expect(
      normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(
      normalizeGoogleGenerativeAiBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(
      normalizeGoogleGenerativeAiBaseUrl(
        "https://generativelanguage.googleapis.com/v1alpha/openai/",
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1alpha");
  });

  it("normalizes Google provider configs by provider key, provider api, or model api", () => {
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("google", {
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        api: "google-generative-ai",
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        models: [{ api: "google-generative-ai" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        api: "openai-completions",
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(false);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("google", {
        api: "openai-completions",
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(false);
  });

  it("normalizes transport baseUrls only for Google Generative AI", () => {
    expect(
      resolveGoogleGenerativeAiTransport({
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(
      resolveGoogleGenerativeAiTransport({
        api: "openai-completions",
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
  });

  it("normalizes google-vertex model ids without rewriting the OpenAI-compatible baseUrl", () => {
    expect(
      normalizeGoogleProviderConfig("google-vertex", {
        api: "openai-completions",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
        models: [
          {
            id: "gemini-3.1-flash-lite",
            name: "Gemini Flash Lite",
            input: ["text"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1,
            maxTokens: 1,
          },
        ],
      }),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl:
        "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
      models: [
        expect.objectContaining({
          id: "gemini-3.1-flash-lite-preview",
        }),
      ],
    });
  });

  it("derives the Gemini API origin without duplicating /v1beta", () => {
    expect(resolveGoogleGenerativeAiApiOrigin()).toBe("https://generativelanguage.googleapis.com");
    expect(resolveGoogleGenerativeAiApiOrigin("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com",
    );
    expect(
      resolveGoogleGenerativeAiApiOrigin("https://generativelanguage.googleapis.com/v1beta"),
    ).toBe("https://generativelanguage.googleapis.com");
  });

  it("parses project-aware oauth auth payloads into bearer headers", () => {
    expect(
      parseGeminiAuth(JSON.stringify({ token: "oauth-token", projectId: "project-1" })),
    ).toEqual({
      headers: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("falls back to API key headers for raw tokens", () => {
    expect(parseGeminiAuth("api-key-123")).toEqual({
      headers: {
        "x-goog-api-key": "api-key-123",
        "Content-Type": "application/json",
      },
    });
  });

  it("builds shared Google Generative AI HTTP request config", () => {
    const oauthConfig = resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      baseUrl: "https://generativelanguage.googleapis.com",
      capability: "audio",
      transport: "media-understanding",
    });
    expect(oauthConfig).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
    });
    expect(Object.fromEntries(new Headers(oauthConfig.headers).entries())).toEqual({
      authorization: "Bearer oauth-token",
      "content-type": "application/json",
    });

    const apiKeyConfig = resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: "api-key-123",
      capability: "image",
      transport: "http",
    });
    expect(apiKeyConfig).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
    });
    expect(Object.fromEntries(new Headers(apiKeyConfig.headers).entries())).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "api-key-123",
    });
  });

  it("preserves explicit OpenAI-compatible Google endpoints during provider normalization", () => {
    expect(
      resolveGoogleGenerativeAiTransport({
        api: "openai-completions",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
  });

  it("strips URL credentials during Google base URL normalization", () => {
    const normalized = normalizeGoogleApiBaseUrl(
      "https://user:secret@generativelanguage.googleapis.com/v1beta/openai?x=1#frag",
    );
    expect(normalized).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });

  it("rejects non-Google Gemini base URLs and ignores smuggled private-network flags", () => {
    expect(() =>
      resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey: "api-key-123",
        baseUrl: "https://proxy.example.com/v1beta",
        capability: "image",
        transport: "http",
      }),
    ).toThrow("Google Generative AI baseUrl must use https://generativelanguage.googleapis.com");

    expect(() =>
      resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey: "api-key-123",
        baseUrl: "http://generativelanguage.googleapis.com/v1beta",
        capability: "image",
        transport: "http",
      }),
    ).toThrow("Google Generative AI baseUrl must use https://generativelanguage.googleapis.com");

    const config = resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: "api-key-123",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      capability: "image",
      transport: "http",
      request: { allowPrivateNetwork: true } as unknown as ProviderRequestTransportOverrides,
    });
    expect(config.allowPrivateNetwork).toBe(false);
  });
});
