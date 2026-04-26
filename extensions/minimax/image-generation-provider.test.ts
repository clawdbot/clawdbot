import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPinnedHostnameTestHooks } from "../../src/media-understanding/audio.test-helpers.js";
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
    expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
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

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/image_generation",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "image-01",
          prompt: "draw a cat",
          response_format: "base64",
          n: 1,
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
