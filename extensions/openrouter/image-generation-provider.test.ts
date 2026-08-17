// Openrouter tests cover image generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequestMock, resolveApiKeyForProviderMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

function requireOpenRouterPostRequest(): Record<string, unknown> {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter image generation request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image generation request");
  }
  return request as Record<string, unknown>;
}

function requireOpenRouterConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter image config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image config request");
  }
  return request;
}

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter image request headers");
  }
  return value;
}

function requireGeneratedImage(
  result: Awaited<
    ReturnType<ReturnType<typeof buildOpenRouterImageGenerationProvider>["generateImage"]>
  >,
  index: number,
) {
  const image = result.images[index];
  if (!image) {
    throw new Error(`expected OpenRouter generated image at index ${index}`);
  }
  return image;
}

function customOpenRouterConfig() {
  return {
    models: {
      providers: {
        openrouter: {
          baseUrl: "https://custom.openrouter.test/api/v1",
          models: [],
        },
      },
    },
  };
}

describe("openrouter image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  });

  it("builds provider metadata and capabilities", () => {
    const provider = buildOpenRouterImageGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/gemini-3.1-flash-image-preview");
    expect(provider.models).toContain("google/gemini-3-pro-image-preview");
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.generate.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(5);
    // Live per-model discovery hook; the runtime overlays its result onto the
    // static capabilities above for the selected model.
    expect(provider.resolveModelCapabilities).toBeTypeOf("function");
  });

  it("preserves chat-completion image requests for configured custom bases", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                images: [
                  {
                    imageUrl: {
                      url: `data:image/png;base64,${Buffer.from("png-one").toString("base64")}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      aspectRatio: "16:9",
      resolution: "2K",
      count: 2,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: customOpenRouterConfig(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: "openrouter",
      cfg: customOpenRouterConfig(),
      agentDir: undefined,
      store: undefined,
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    expect(requireOpenRouterConfigRequest()).toEqual({
      baseUrl: "https://custom.openrouter.test/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      defaultHeaders: {
        Authorization: "Bearer openrouter-key",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      request: undefined,
      provider: "openrouter",
      capability: "image",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireOpenRouterPostRequest();
    const headers = requireHeaders(request.headers);
    expect(Object.fromEntries(headers.entries())).toEqual({
      authorization: "Bearer openrouter-key",
      "http-referer": "https://openclaw.ai",
      "x-openrouter-title": "OpenClaw",
    });
    expect(request).toEqual({
      url: "https://custom.openrouter.test/api/v1/chat/completions",
      headers,
      body: {
        model: "google/gemini-3.1-flash-image-preview",
        messages: [
          {
            role: "user",
            content: "draw a sticker",
          },
        ],
        modalities: ["image", "text"],
        n: 2,
        image_config: {
          aspect_ratio: "16:9",
          image_size: "2K",
        },
      },
      timeoutMs: 12_345,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
    });
    const image = requireGeneratedImage(result, 0);
    expect(image.buffer.toString()).toBe("png-one");
    expect(image.mimeType).toBe("image/png");
    expect(release).toHaveBeenCalledOnce();
  });

  it("applies configured image request transport without weakening private-network policy", async () => {
    const requestPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Trace": "image-trace" },
      auth: { mode: "authorization-bearer" as const, token: "override-image-token" },
      proxy: { mode: "explicit-proxy" as const, url: "http://proxy.example.test:8443" },
      tls: { ca: "synthetic-provider-ca", serverName: "provider.example.test" },
    };
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: requestPolicy.proxy.url,
    };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const headers = new Headers(params.defaultHeaders);
      for (const [name, value] of Object.entries(params.request?.headers ?? {})) {
        headers.set(name, value);
      }
      if (params.request?.auth?.mode === "authorization-bearer") {
        headers.set("Authorization", `Bearer ${params.request.auth.token}`);
      }
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork:
          (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
        headers,
        dispatcherPolicy,
      };
    });
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        choices: [
          {
            message: {
              images: [{ image_url: { url: "data:image/png;base64,cG5n" } }],
            },
          },
        ],
      }),
      release,
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw through the configured transport",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              request: requestPolicy,
              models: [],
            },
          },
        },
      },
    });

    expect(requireOpenRouterConfigRequest()).toMatchObject({
      baseUrl: "https://custom.openrouter.test/api/v1",
      provider: "openrouter",
      capability: "image",
      allowPrivateNetwork: false,
      request: requestPolicy,
    });
    const request = requireOpenRouterPostRequest();
    const headers = requireHeaders(request.headers);
    expect(headers.get("authorization")).toBe("Bearer override-image-token");
    expect(headers.get("x-openrouter-trace")).toBe("image-trace");
    expect(request).toMatchObject({
      url: "https://custom.openrouter.test/api/v1/chat/completions",
      allowPrivateNetwork: false,
      dispatcherPolicy,
    });
    expect(requireGeneratedImage(result, 0).buffer.toString()).toBe("png");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a 180s default timeout when no request timeout is provided", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/images",
        timeoutMs: 180_000,
      }),
    );
  });

  it("normalizes the official legacy base before selecting the dedicated route", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/v1/",
              models: [],
            },
          },
        },
      },
    });

    expect(requireOpenRouterPostRequest().url).toBe("https://openrouter.ai/api/v1/images");
  });

  it("sends canonical reference images as input_references", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [
          {
            b64_json: Buffer.from("webp-one").toString("base64"),
            media_type: "image/webp",
          },
        ],
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "turn this into watercolor",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      cfg: {},
    });

    const request = requireOpenRouterPostRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
    expect((request.body as Record<string, unknown>).input_references).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
        },
      },
    ]);
    const image = requireGeneratedImage(result, 0);
    expect(image.buffer.toString()).toBe("webp-one");
    expect(image.mimeType).toBe("image/webp");
  });

  // Regression guard: the dedicated /images body must not be gated by model
  // family — pre-discovery code silently dropped these axes for non-Gemini models.
  it("forwards aspect_ratio for non-Gemini models on the dedicated endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-wide").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      prompt: "draw a wide banner",
      aspectRatio: "16:9",
      cfg: {},
    });

    const request = requireOpenRouterPostRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
    expect(request.body).toEqual({
      model: "openai/gpt-5.4-image-2",
      prompt: "draw a wide banner",
      n: 1,
      aspect_ratio: "16:9",
    });
  });

  it("forwards sanitized quality and background on the dedicated endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-hq").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      prompt: "draw a logo",
      quality: "high",
      background: "opaque",
      cfg: {},
    });

    expect(requireOpenRouterPostRequest().body).toEqual({
      model: "openai/gpt-5.4-image-2",
      prompt: "draw a logo",
      n: 1,
      quality: "high",
      background: "opaque",
    });
  });

  it("forwards aspect_ratio and resolution for Gemini models on the dedicated endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-gem").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a wide banner",
      aspectRatio: "16:9",
      resolution: "2K",
      cfg: {},
    });

    expect(requireOpenRouterPostRequest().body).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a wide banner",
      n: 1,
      aspect_ratio: "16:9",
      resolution: "2K",
    });
  });

  // Pin: the legacy custom-base path keeps its Google-specific image_config and
  // Gemini gate — discovery does not apply off the canonical base (see §3.4).
  it("keeps custom-base chat completions Gemini-gated with no geometry for other models", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        choices: [
          {
            message: {
              images: [{ image_url: { url: "data:image/png;base64,cG5n" } }],
            },
          },
        ],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      prompt: "draw a wide banner",
      aspectRatio: "16:9",
      quality: "high",
      cfg: customOpenRouterConfig(),
    });

    const request = requireOpenRouterPostRequest();
    expect(request.url).toBe("https://custom.openrouter.test/api/v1/chat/completions");
    expect(request.body).toEqual({
      model: "openai/gpt-5.4-image-2",
      messages: [{ role: "user", content: "draw a wide banner" }],
      modalities: ["image", "text"],
      n: 1,
    });
  });

  it.each(["google/gemini-3.1-flash-image-preview", "openai/gpt-5.4-image-2"])(
    "fans out canonical %s batches into bounded single-image requests",
    async (model) => {
      postJsonRequestMock
        .mockResolvedValueOnce({
          response: Response.json({
            data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
          }),
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: Response.json({
            data: [{ b64_json: Buffer.from("png-two").toString("base64") }],
          }),
          release: vi.fn(async () => {}),
        });

      const result = await buildOpenRouterImageGenerationProvider().generateImage({
        provider: "openrouter",
        model,
        prompt: "draw two stickers",
        count: 2,
        cfg: {},
      });

      expect(postJsonRequestMock).toHaveBeenCalledTimes(2);
      expect(
        postJsonRequestMock.mock.calls.map(([request]) => ({
          url: Reflect.get(request as object, "url"),
          body: Reflect.get(request as object, "body"),
        })),
      ).toEqual([
        {
          url: "https://openrouter.ai/api/v1/images",
          body: {
            model,
            prompt: "draw two stickers",
            n: 1,
          },
        },
        {
          url: "https://openrouter.ai/api/v1/images",
          body: {
            model,
            prompt: "draw two stickers",
            n: 1,
          },
        },
      ]);
      expect(result.images.map((image) => image.buffer.toString())).toEqual(["png-one", "png-two"]);
    },
  );

  it("fails a canonical batch when any request fails", async () => {
    postJsonRequestMock
      .mockResolvedValueOnce({
        response: Response.json({
          data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
        }),
        release: vi.fn(async () => {}),
      })
      .mockRejectedValueOnce(new Error("upstream capacity"));

    await expect(
      buildOpenRouterImageGenerationProvider().generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "draw two stickers",
        count: 2,
        cfg: {},
      }),
    ).rejects.toThrow("upstream capacity");
  });

  it("wraps wrong-shape successful dedicated image responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({ data: { b64_json: "bad-shape" } }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "bad shape",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter image generation response malformed");
  });

  it("extracts image fallbacks from string content and raw b64 parts", async () => {
    const png = Buffer.from("png-inline").toString("base64");
    const raw = Buffer.from("raw-inline").toString("base64");
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                content: `done data:image/png;base64,${png}`,
              },
            },
            {
              message: {
                content: [{ b64_json: raw }],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw image fallbacks",
      cfg: customOpenRouterConfig(),
    });

    expect(result.images.map((image) => image.buffer.toString())).toEqual([
      "png-inline",
      "raw-inline",
    ]);
  });

  it("rejects invalid raw image parts in strict extraction mode", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                content: [{ b64_json: "not-base64!" }],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    await expect(
      buildOpenRouterImageGenerationProvider().generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "draw invalid fallback",
        cfg: customOpenRouterConfig(),
      }),
    ).rejects.toThrow("OpenRouter image generation response malformed");
  });
});
