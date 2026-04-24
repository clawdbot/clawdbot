import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleImageGenerationProvider } from "./image-generation-provider.js";
import { __testing as geminiWebSearchTesting } from "./src/gemini-web-search-provider.js";

function mockGoogleApiKeyAuth() {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-test-key",
    source: "env",
    mode: "api-key",
  });
}

function installGoogleFetchMock(params?: {
  data?: string;
  mimeType?: string;
  inlineDataKey?: "inlineData" | "inline_data";
}) {
  const mimeType = params?.mimeType ?? "image/png";
  const data = params?.data ?? "png-data";
  const inlineDataKey = params?.inlineDataKey ?? "inlineData";
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                [inlineDataKey]: {
                  [inlineDataKey === "inlineData" ? "mimeType" : "mime_type"]: mimeType,
                  data: Buffer.from(data).toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates image buffers from the Gemini generateContent API", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: "generated" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("png-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a cat",
      cfg: {},
      size: "1536x1024",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: "draw a cat" }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "3:2",
              imageSize: "2K",
            },
          },
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("accepts OAuth JSON auth and inline_data responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      source: "profile",
      mode: "token",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: Buffer.from("jpg-data").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a dog",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          mimeType: "image/jpeg",
          fileName: "image-1.jpg",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("sends reference images and explicit resolution for edit flows", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "Change only the sky to a sunset.",
      cfg: {},
      resolution: "4K",
      inputImages: [
        {
          buffer: Buffer.from("reference-bytes"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("reference-bytes").toString("base64"),
                  },
                },
                { text: "Change only the sky to a sunset." },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              imageSize: "4K",
            },
          },
        }),
      }),
    );
  });

  it("forwards explicit aspect ratio without forcing a default when size is omitted", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "portrait photo",
      cfg: {},
      aspectRatio: "9:16",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: "portrait photo" }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16",
            },
          },
        }),
      }),
    );
  });

  it("disables DNS pinning for Google image generation requests", async () => {
    mockGoogleApiKeyAuth();
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a fox",
      cfg: {},
    });

    expect(postJsonRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("honors configured private-network opt-in for Google image generation", async () => {
    mockGoogleApiKeyAuth();
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a fox",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
    });

    expect(postJsonRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
  });

  it("normalizes a configured bare Google host to the v1beta API root", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [],
            },
          },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.any(Object),
    );
  });

  it("strips a configured /openai suffix before calling the native Gemini image API", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      prompt: "draw a fox",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              models: [],
            },
          },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.any(Object),
    );
  });

  it("prefers scoped configured Gemini API keys over environment fallbacks", () => {
    expect(
      geminiWebSearchTesting.resolveGeminiApiKey({
        apiKey: "gemini-secret",
      }),
    ).toBe("gemini-secret");
  });

  it("falls back to the default Gemini model when unset or blank", () => {
    expect(geminiWebSearchTesting.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(geminiWebSearchTesting.resolveGeminiModel({ model: "  " })).toBe("gemini-2.5-flash");
    expect(geminiWebSearchTesting.resolveGeminiModel({ model: "gemini-2.5-pro" })).toBe(
      "gemini-2.5-pro",
    );
  });
});
