import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenRouterImageGenerationProvider,
  extractOpenRouterImagesFromResponse,
} from "./image-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function requireOpenRouterPostBody(): {
  messages?: Array<{ content?: unknown }>;
} {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request) {
    throw new Error("expected OpenRouter image generation request");
  }
  return request.body as { messages?: Array<{ content?: unknown }> };
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

describe("openrouter image generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
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
  });

  it("sends chat completion image requests with Gemini image config and count", async () => {
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
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
            },
          },
        },
      } as never,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        capability: "image",
        baseUrl: "https://custom.openrouter.test/api/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://custom.openrouter.test/api/v1/chat/completions",
        timeoutMs: 12_345,
        body: expect.objectContaining({
          model: "google/gemini-3.1-flash-image-preview",
          modalities: ["image", "text"],
          n: 2,
          image_config: {
            aspect_ratio: "16:9",
            image_size: "2K",
          },
          messages: [
            {
              role: "user",
              content: "draw a sticker",
            },
          ],
        }),
      }),
    );
    const image = requireGeneratedImage(result, 0);
    expect(image.buffer.toString()).toBe("png-one");
    expect(image.mimeType).toBe("image/png");
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends reference images as data URLs for edit-style requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/webp;base64,${Buffer.from("webp-one").toString("base64")}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "turn this into watercolor",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      cfg: {} as never,
    });

    const body = requireOpenRouterPostBody();
    expect(body.messages?.[0]?.content).toEqual([
      { type: "text", text: "turn this into watercolor" },
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

  it("extracts image fallbacks from string content and raw b64 parts", () => {
    const png = Buffer.from("png-inline").toString("base64");
    const raw = Buffer.from("raw-inline").toString("base64");
    const images = extractOpenRouterImagesFromResponse({
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
    });

    expect(images.map((image) => image.buffer.toString())).toEqual(["png-inline", "raw-inline"]);
  });
});
