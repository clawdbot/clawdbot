import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMinimaxImageGenerationProvider,
  buildMinimaxPortalImageGenerationProvider,
} from "./image-generation-provider.js";

installPinnedHostnameTestHooks();

describe("minimax image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MINIMAX_API_HOST", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function mockMinimaxApiKey() {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "minimax-test-key",
      source: "env",
      mode: "api-key",
    });
  }

  function mockSuccessfulMinimaxImageResponse() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            image_base64: [Buffer.from("png-data").toString("base64")],
          },
          base_resp: { status_code: 0 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function expectImageGenerationUrl(fetchMock: ReturnType<typeof vi.fn>, url: string) {
    expect(fetchMock).toHaveBeenCalled();
    const [actualUrl, init] = fetchMock.mock.calls.at(0) as [string, RequestInit | undefined];
    expect(actualUrl).toBe(url);
    expect(init?.method).toBe("POST");
  }

  function requireFirstPostJsonRequest(mock: ReturnType<typeof vi.fn>): {
    body?: unknown;
    ssrfPolicy?: unknown;
    url?: string;
  } {
    const [call] = mock.mock.calls;
    if (!call) {
      throw new Error("expected MiniMax image request");
    }
    const [request] = call;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("expected MiniMax image request");
    }
    return request as { body?: unknown; url?: string };
  }

  it("generates PNG buffers through the shared provider HTTP path", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls.at(0) as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        model: "image-01",
        prompt: "draw a cat",
        response_format: "base64",
        n: 1,
      }),
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer minimax-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "image-01",
    });
  });

  it("passes request SSRF policy to the provider HTTP helper", async () => {
    mockMinimaxApiKey();
    const postJsonRequest = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      response: new Response(
        JSON.stringify({
          data: { image_base64: [Buffer.from("png-data").toString("base64")] },
          base_resp: { status_code: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://api.minimax.io/v1/image_generation",
      release: async () => {},
    });

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {},
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(postJsonRequest).toHaveBeenCalledOnce();
    const request = requireFirstPostJsonRequest(postJsonRequest);
    expect(request.url).toBe("https://api.minimax.io/v1/image_generation");
    expect(request.body).toEqual({
      model: "image-01",
      prompt: "draw a cat",
      response_format: "base64",
      n: 1,
    });
    expect(request.ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
  });

  it("keeps the dedicated global image endpoint when text config uses the global API host", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimax.io/v1/image_generation");
  });

  it("does not inherit unrelated MiniMax text endpoint hosts for image generation", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.chat/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimax.io/v1/image_generation");
  });

  it("uses the dedicated CN image endpoint when CN API host is configured", async () => {
    vi.stubEnv("MINIMAX_API_HOST", "https://api.minimaxi.com/anthropic");
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {},
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimaxi.com/v1/image_generation");
  });

  it("infers the dedicated CN image endpoint from MiniMax provider config", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimaxi.com/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimaxi.com/v1/image_generation");
  });

  it("infers the dedicated CN image endpoint from MiniMax Portal provider config", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxPortalImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax-portal",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            "minimax-portal": {
              baseUrl: "api.minimaxi.com/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimaxi.com/v1/image_generation");
  });

  it("ignores private custom text endpoints for image generation", async () => {
    mockMinimaxApiKey();
    const fetchMock = mockSuccessfulMinimaxImageResponse();

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      provider: "minimax",
      model: "image-01",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "http://127.0.0.1:8080/anthropic",
              models: [],
            },
          },
        },
      },
    });

    expectImageGenerationUrl(fetchMock, "https://api.minimax.io/v1/image_generation");
  });
});
