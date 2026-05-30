import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

import {
  setFalFetchGuardForTesting,
  buildFalImageGenerationProvider,
} from "./image-generation-provider.js";

function expectFalJsonPost(params: { call: number; url: string; body: Record<string, unknown> }) {
  const request = fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0];
  if (!request) {
    throw new Error(`expected fal fetch request #${params.call}`);
  }
  expect(request.url).toBe(params.url);
  expect(request.auditContext).toBe("fal-image-generate");
  expect(request.policy).toBeUndefined();
  expect(request.init?.method).toBe("POST");
  const headers = new Headers(request.init?.headers);
  expect(headers.get("authorization")).toBe("Key fal-test-key");
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(String(request.init?.body))).toEqual(params.body);
}

function expectFalDownload(params: { call: number; url: string }) {
  expect(fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0]).toEqual({
    url: params.url,
    policy: undefined,
    auditContext: "fal-image-download",
  });
}

describe("fal image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setFalFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("generates image buffers from the fal sync API", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    const releaseRequest = vi.fn(async () => {});
    const releaseDownload = vi.fn(async () => {});
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [
              {
                url: "https://v3.fal.media/files/example/generated.png",
                content_type: "image/png",
              },
            ],
            prompt: "draw a cat",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: releaseRequest,
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: releaseDownload,
      });

    const provider = buildFalImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      cfg: {},
      count: 2,
      size: "1536x1024",
      outputFormat: "jpeg",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        image_size: { width: 1536, height: 1024 },
        num_images: 2,
        output_format: "jpeg",
      },
    });
    expectFalDownload({ call: 2, url: "https://v3.fal.media/files/example/generated.png" });
    expect(releaseRequest).toHaveBeenCalledTimes(1);
    expect(releaseDownload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "fal-ai/flux/dev",
      metadata: { prompt: "draw a cat" },
    });
  });

  it("rejects generated image downloads that exceed the configured media cap", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/generated.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("too-large"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("fal generated image download exceeds 1 bytes");
  });

  it("wraps wrong-shape successful fal image responses", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ images: { url: "https://example.test/image.png" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow("fal image generation response malformed");
  });

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "turn this into a noir poster",
      cfg: {},
      resolution: "2K",
      inputImages: [
        {
          buffer: Buffer.from("source-image"),
          mimeType: "image/jpeg",
          fileName: "source.jpg",
        },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev/image-to-image",
      body: {
        prompt: "turn this into a noir poster",
        image_size: { width: 2048, height: 2048 },
        num_images: 1,
        output_format: "png",
        image_url: `data:image/jpeg;base64,${Buffer.from("source-image").toString("base64")}`,
      },
    });
  });

  it("routes GPT Image 2 edits through /edit with image_urls", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/gpt-edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("gpt-edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "openai/gpt-image-2",
      prompt: "combine these references",
      cfg: {},
      aspectRatio: "16:9",
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/jpeg" },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/openai/gpt-image-2/edit",
      body: {
        prompt: "combine these references",
        image_size: "landscape_16_9",
        num_images: 1,
        output_format: "png",
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/jpeg;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    });
  });

  it("allows GPT Image 2 edits up to 10 reference images", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/gpt-edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("gpt-edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const inputImages = Array.from({ length: 10 }, (_, index) => ({
      buffer: Buffer.from(`ref-${index + 1}`),
      mimeType: "image/png",
    }));

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "openai/gpt-image-2",
      prompt: "combine all references",
      cfg: {},
      inputImages,
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/openai/gpt-image-2/edit",
      body: {
        prompt: "combine all references",
        num_images: 1,
        output_format: "png",
        image_urls: inputImages.map(
          (image) => `data:image/png;base64,${image.buffer.toString("base64")}`,
        ),
      },
    });
  });

  it("rejects GPT Image 2 edits above 10 reference images", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "openai/gpt-image-2",
        prompt: "too many references",
        cfg: {},
        inputImages: Array.from({ length: 11 }, () => ({
          buffer: Buffer.from("ref"),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow("fal GPT Image edit supports at most 10 reference images");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("routes Nano Banana 2 text generation with native resolution", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/nb2-wide.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("nb2-wide-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/nano-banana-2",
      prompt: "ultrawide banana test",
      cfg: {},
      aspectRatio: "4:1",
      resolution: "2K",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/nano-banana-2",
      body: {
        prompt: "ultrawide banana test",
        aspect_ratio: "4:1",
        resolution: "2K",
        num_images: 1,
        output_format: "png",
      },
    });
  });

  it("does not synthesize Nano Banana 2 aspect ratio from resolution alone", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/nb2-auto.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("nb2-auto-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/nano-banana-2",
      prompt: "auto aspect banana test",
      cfg: {},
      resolution: "2K",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/nano-banana-2",
      body: {
        prompt: "auto aspect banana test",
        resolution: "2K",
        num_images: 1,
        output_format: "png",
      },
    });
  });

  it("routes Nano Banana 2 edits through /edit with NB2 geometry", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/nb2-edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("nb2-edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/nano-banana-2",
      prompt: "blend these references",
      cfg: {},
      aspectRatio: "9:16",
      resolution: "2K",
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/png" },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/nano-banana-2/edit",
      body: {
        prompt: "blend these references",
        aspect_ratio: "9:16",
        resolution: "2K",
        num_images: 1,
        output_format: "png",
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/png;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    });
  });

  it("rejects Nano Banana 2 edits above 14 reference images", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/nano-banana-2",
        prompt: "too many references",
        cfg: {},
        inputImages: Array.from({ length: 15 }, () => ({
          buffer: Buffer.from("ref"),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow("fal Nano Banana 2 supports at most 14 reference images");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects Krea-only aspect ratios for Nano Banana 2", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/nano-banana-2",
        prompt: "unsupported ratio",
        cfg: {},
        aspectRatio: "2.35:1",
      }),
    ).rejects.toThrow("fal Nano Banana 2 supports aspectRatio values");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("preserves exact custom Fal edit endpoints", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/custom-edit.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("custom-edit-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/custom/edit",
      prompt: "edit through custom endpoint",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/custom/edit",
      body: {
        prompt: "edit through custom endpoint",
        num_images: 1,
        output_format: "png",
        image_url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
      },
    });
  });

  it("maps aspect ratio for text generation without forcing a square default", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/wide.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("wide-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "wide cinematic shot",
      cfg: {},
      aspectRatio: "16:9",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "wide cinematic shot",
        image_size: "landscape_16_9",
        num_images: 1,
        output_format: "png",
      },
    });
  });

  it("combines resolution and aspect ratio for text generation", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/portrait.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("portrait-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "portrait poster",
      cfg: {},
      resolution: "2K",
      aspectRatio: "9:16",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "portrait poster",
        image_size: { width: 1152, height: 2048 },
        num_images: 1,
        output_format: "png",
      },
    });
  });

  it("uses Krea 2 native aspect-ratio and creativity payload schema", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/krea.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("krea-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "fal",
      model: "krea/v2/medium/text-to-image",
      prompt: "expressive risograph poster",
      cfg: {},
      aspectRatio: "9:16",
      providerOptions: {
        fal: {
          creativity: "high",
        },
      },
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/krea/v2/medium/text-to-image",
      body: {
        prompt: "expressive risograph poster",
        creativity: "high",
        aspect_ratio: "9:16",
      },
    });
    expect(result.model).toBe("krea/v2/medium/text-to-image");
  });

  it("passes reference images to Krea 2 as style references without edit suffix", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/krea-style.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("krea-style-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "krea/v2/large/text-to-image",
      prompt: "portrait with the same palette and texture",
      cfg: {},
      size: "1024x1536",
      inputImages: [
        { buffer: Buffer.from("style-a"), mimeType: "image/png" },
        { buffer: Buffer.from("style-b"), mimeType: "image/jpeg" },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/krea/v2/large/text-to-image",
      body: {
        prompt: "portrait with the same palette and texture",
        creativity: "medium",
        aspect_ratio: "2:3",
        image_style_references: [
          { image_url: `data:image/png;base64,${Buffer.from("style-a").toString("base64")}` },
          { image_url: `data:image/jpeg;base64,${Buffer.from("style-b").toString("base64")}` },
        ],
      },
    });
  });

  it("maps Krea 2 size hints to the closest native aspect ratio", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/krea-sized.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("krea-sized-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "krea/v2/medium/text-to-image",
      prompt: "portrait poster",
      cfg: {},
      size: "1024x1536",
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/krea/v2/medium/text-to-image",
      body: {
        prompt: "portrait poster",
        creativity: "medium",
        aspect_ratio: "2:3",
      },
    });
  });

  it("rejects Krea 2 resolution hints instead of dropping them", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "krea/v2/medium/text-to-image",
        prompt: "too many pixels",
        cfg: {},
        resolution: "2K",
      }),
    ).rejects.toThrow("fal Krea 2 supports aspectRatio but not resolution overrides");
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "krea/v2/medium/text-to-image",
        prompt: "style refs with unsupported pixels",
        cfg: {},
        resolution: "1K",
        inputImages: [{ buffer: Buffer.from("style"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("fal Krea 2 supports aspectRatio but not resolution overrides");
  });

  it("rejects multi-image count for Krea 2 single-image endpoints", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "krea/v2/medium/text-to-image",
        prompt: "too many outputs",
        cfg: {},
        count: 2,
      }),
    ).rejects.toThrow("supports one output image per request");
  });

  it("rejects output format overrides for Krea 2", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "krea/v2/medium/text-to-image",
        prompt: "jpeg please",
        cfg: {},
        outputFormat: "jpeg",
      }),
    ).rejects.toThrow("does not support outputFormat overrides");
  });

  it("rejects multi-image for Flux edit", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "combine these",
        cfg: {},
        inputImages: [
          { buffer: Buffer.from("one"), mimeType: "image/png" },
          { buffer: Buffer.from("two"), mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow("at most one reference image");
  });

  it("rejects aspect ratio for Flux edit", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "make it widescreen",
        cfg: {},
        aspectRatio: "16:9",
        inputImages: [{ buffer: Buffer.from("one"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("does not support aspectRatio overrides");
  });

  it("blocks private-network image download URLs through the SSRF guard", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    const blocked = new Error("Blocked: resolves to private/internal/special-use IP address");
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockRejectedValueOnce(blocked);

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toThrow(blocked.message);

    expectFalDownload({
      call: 2,
      url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    });
  });

  it("does not auto-whitelist trusted private relay hosts from a configured baseUrl", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "http://media.relay.internal/files/generated.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      cfg: {
        models: {
          providers: {
            fal: {
              baseUrl: "http://relay.internal:8080",
              models: [],
            },
          },
        },
      },
    });

    expectFalJsonPost({
      call: 1,
      url: "http://relay.internal:8080/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        num_images: 1,
        output_format: "png",
      },
    });
    expectFalDownload({ call: 2, url: "http://media.relay.internal/files/generated.png" });
  });
});
