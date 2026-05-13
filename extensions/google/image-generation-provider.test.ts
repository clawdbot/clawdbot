import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleImageGenerationProvider } from "./image-generation-provider.js";
import { __testing as geminiWebSearchTesting } from "./src/gemini-web-search-provider.js";

let ssrfMock: { mockRestore: () => void } | undefined;

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

function fetchRequest(fetchMock: ReturnType<typeof vi.fn>): {
  body?: string;
  headers?: HeadersInit;
  method?: string;
  url: string;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(typeof url).toBe("string");
  if (!init) {
    throw new Error("Expected fetch init");
  }
  return {
    body: typeof init.body === "string" ? init.body : undefined,
    headers: init.headers,
    method: init.method,
    url,
  };
}

function postJsonRequestOptions(spy: unknown): {
  allowPrivateNetwork?: boolean;
  pinDns?: boolean;
  ssrfPolicy?: { allowRfc2544BenchmarkRange?: boolean };
} {
  const options = (spy as { mock?: { calls?: Array<[unknown]> } }).mock?.calls?.[0]?.[0];
  if (!options) {
    throw new Error("Expected postJsonRequest options");
  }
  return options as {
    allowPrivateNetwork?: boolean;
    pinDns?: boolean;
    ssrfPolicy?: { allowRfc2544BenchmarkRange?: boolean };
  };
}

describe("Google image-generation provider", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
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
    });
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

  it("passes request SSRF policy to the provider HTTP helper", async () => {
    mockGoogleApiKeyAuth();
    const postJsonRequest = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      response: new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
      release: async () => {},
    });

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a cat",
      cfg: {},
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(postJsonRequestOptions(postJsonRequest).ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
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

    const request = fetchRequest(fetchMock);
    expect(request.url.length).toBeGreaterThan(0);
    expect(request.headers).toBeInstanceOf(Headers);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer oauth-token");
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

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
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
    });
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

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body ?? "")).toEqual({
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
    });
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

    expect(postJsonRequestOptions(postJsonRequestSpy).pinDns).toBe(false);
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

    expect(postJsonRequestOptions(postJsonRequestSpy).allowPrivateNetwork).toBe(true);
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

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    );
    expect(typeof request.method).toBe("string");
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

    const request = fetchRequest(fetchMock);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    );
    expect(typeof request.method).toBe("string");
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
