import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPinnedHostnameTestHooks } from "../../src/media-understanding/audio.test-helpers.js";
import { buildMinimaxImageGenerationProvider } from "./image-generation-provider.js";

installPinnedHostnameTestHooks();

describe("minimax image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("uses the configured provider base URL origin", async () => {
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

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/image_generation",
      expect.any(Object),
    );
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    mockMinimaxApiKey();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildMinimaxImageGenerationProvider();
    await expect(
      provider.generateImage({
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
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
