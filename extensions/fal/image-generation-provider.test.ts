// Fal tests cover image generation provider plugin behavior.
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

function expectFalDownload(params: { call: number; url: string; timeoutMs?: number }) {
  expect(fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0]).toEqual({
    url: params.url,
    timeoutMs: params.timeoutMs ?? 30_000,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes model-specific Grok and Nano Banana 2 Lite geometry", () => {
    const geometry = buildFalImageGenerationProvider().capabilities.geometry;
    const edit = buildFalImageGenerationProvider().capabilities.edit;
    const grokRatios = geometry?.aspectRatiosByModel?.["xai/grok-imagine-image"];
    const grokResolutions = geometry?.resolutionsByModel?.["xai/grok-imagine-image"];
    const nanoResolutions = geometry?.resolutionsByModel?.["google/nano-banana-2-lite"];

    expect(grokRatios).toContain("2:1");
    expect(grokRatios).toContain("20:9");
    expect(geometry?.aspectRatiosByModel?.["fal-ai/nano-banana"]).toContain("21:9");
    expect(geometry?.aspectRatiosByModel?.["fal-ai/nano-banana"]).not.toContain("4:1");
    expect(grokResolutions).toEqual(["1K", "2K"]);
    expect(geometry?.aspectRatiosByModel?.["xai/grok-imagine-image/edit"]).toEqual(grokRatios);
    expect(geometry?.resolutionsByModel?.["xai/grok-imagine-image/quality/edit"]).toEqual(
      grokResolutions,
    );
    expect(nanoResolutions).toEqual([]);
    expect(geometry?.resolutionsByModel?.["google/nano-banana-2-lite/edit"]).toEqual([]);
    expect(edit.maxInputImages).toBe(1);
    expect(edit.maxInputImagesByModel?.["fal-ai/nano-banana"]).toBe(3);
    expect(edit.maxInputImagesByModelPrefix?.["fal-ai/nano-banana-"]).toBe(14);
    expect(edit.maxInputImagesByModelPrefix?.["google/nano-banana-2-lite"]).toBe(14);
    expect(edit.maxInputImagesByModelPrefix?.["xai/grok-imagine-image"]).toBe(3);
    expect(edit.maxInputImagesByModelPrefix?.["openai/gpt-image-"]).toBe(10);
    expect(geometry?.resolutionsByModel?.["xai/grok-imagine-image/quality"]).toEqual(
      grokResolutions,
    );
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

  it("shares an explicit operation deadline across generated image downloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00Z"));
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockImplementation(async () => {
      vi.advanceTimersByTime(5_000);
      return {
        apiKey: "fal-test-key",
        source: "env",
        mode: "api-key",
      };
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(10_000);
        return {
          response: new Response(
            JSON.stringify({
              images: [
                { url: "https://v3.fal.media/files/example/first.png" },
                { url: "https://v3.fal.media/files/example/second.png" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
          release: vi.fn(async () => {}),
        };
      })
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(20_000);
        return {
          response: new Response(Buffer.from("first"), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
          release: vi.fn(async () => {}),
        };
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("second"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const result = await buildFalImageGenerationProvider().generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "draw two cats",
      cfg: {},
      timeoutMs: 180_000,
      count: 2,
    });

    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.timeoutMs).toBe(175_000);
    expectFalDownload({
      call: 2,
      url: "https://v3.fal.media/files/example/first.png",
      timeoutMs: 165_000,
    });
    expectFalDownload({
      call: 3,
      url: "https://v3.fal.media/files/example/second.png",
      timeoutMs: 145_000,
    });
    expect(result.images.map((image) => image.buffer.toString())).toEqual(["first", "second"]);
  });

  it("releases a timed-out generated image download", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    const releaseDownload = vi.fn(async () => {});
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/slow.png" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("timed out", "TimeoutError"));
            },
          }),
          { status: 200, headers: { "content-type": "image/png" } },
        ),
        release: releaseDownload,
      });

    await expect(
      buildFalImageGenerationProvider().generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        cfg: {},
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(releaseDownload).toHaveBeenCalledTimes(1);
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

  it.each([
    { model: "fal-ai/nano-banana", resolution: undefined },
    { model: "fal-ai/nano-banana-2", resolution: "2K" as const },
  ])("routes $model edits through /edit with model geometry", async ({ model, resolution }) => {
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
      model,
      prompt: "blend these references",
      cfg: {},
      aspectRatio: "9:16",
      ...(resolution ? { resolution } : {}),
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/png" },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: `https://fal.run/${model}/edit`,
      body: {
        prompt: "blend these references",
        aspect_ratio: "9:16",
        ...(resolution ? { resolution } : {}),
        num_images: 1,
        output_format: "png",
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/png;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    });
  });

  it.each([
    {
      model: "fal-ai/nano-banana",
      inputCount: 4,
      error: "fal Nano Banana supports at most 3 reference images",
    },
    {
      model: "fal-ai/nano-banana-2",
      inputCount: 15,
      error: "fal Nano Banana 2 supports at most 14 reference images",
    },
  ])("rejects $model edits above its reference limit", async ({ model, inputCount, error }) => {
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
        model,
        prompt: "too many references",
        cfg: {},
        inputImages: Array.from({ length: inputCount }, () => ({
          buffer: Buffer.from("ref"),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow(error);
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

  it("routes Nano Banana 2 Lite edits through /edit with image_urls", async () => {
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
            images: [{ url: "https://v3.fal.media/files/example/nb2-lite-edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("nb2-lite-edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "google/nano-banana-2-lite",
      prompt: "drive the man down the coastline",
      cfg: {},
      aspectRatio: "3:2",
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/png" },
      ],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/google/nano-banana-2-lite/edit",
      body: {
        prompt: "drive the man down the coastline",
        aspect_ratio: "3:2",
        num_images: 1,
        output_format: "png",
        image_urls: [
          `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
          `data:image/png;base64,${Buffer.from("second").toString("base64")}`,
        ],
      },
    });
  });

  it("rejects Krea-only aspect ratios for Nano Banana 2 Lite", async () => {
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
        model: "google/nano-banana-2-lite",
        prompt: "unsupported ratio",
        cfg: {},
        aspectRatio: "2.35:1",
      }),
    ).rejects.toThrow("fal Nano Banana 2 Lite supports aspectRatio values");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each(["1K", "2K", "4K"] as const)(
    "rejects %s resolution overrides for Nano Banana 2 Lite",
    async (resolution) => {
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
          model: "google/nano-banana-2-lite",
          prompt: "unsupported resolution",
          cfg: {},
          aspectRatio: "1:1",
          resolution,
          inputImages: [{ buffer: Buffer.from("src"), mimeType: "image/png" }],
        }),
      ).rejects.toThrow("fal Nano Banana 2 Lite does not support resolution overrides");
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("rejects Nano Banana 2 Lite edits above 14 reference images", async () => {
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
        model: "google/nano-banana-2-lite",
        prompt: "too many references",
        cfg: {},
        inputImages: Array.from({ length: 15 }, () => ({
          buffer: Buffer.from("ref"),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow("fal Nano Banana 2 Lite supports at most 14 reference images");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Nano Banana 2 Lite",
      model: "google/nano-banana-2-lite",
      aspectRatio: "3:2",
      resolution: undefined,
      expectedBody: {
        prompt: "generate without references",
        aspect_ratio: "3:2",
        num_images: 1,
        output_format: "png",
      },
    },
    {
      label: "Grok Imagine",
      model: "xai/grok-imagine-image",
      aspectRatio: "16:9",
      resolution: "2K" as const,
      expectedBody: {
        prompt: "generate without references",
        aspect_ratio: "16:9",
        resolution: "2k",
        num_images: 1,
        output_format: "png",
      },
    },
  ])("keeps $label text-to-image on its base endpoint", async (testCase) => {
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
        response: new Response(Buffer.from("generated-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: testCase.model,
      prompt: "generate without references",
      cfg: {},
      aspectRatio: testCase.aspectRatio,
      resolution: testCase.resolution,
    });

    expectFalJsonPost({
      call: 1,
      url: `https://fal.run/${testCase.model}`,
      body: testCase.expectedBody,
    });
  });

  it("routes Grok Imagine edits through /edit with lowercase resolution", async () => {
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
            images: [{ url: "https://v3.fal.media/files/example/grok-edited.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("grok-edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "xai/grok-imagine-image",
      prompt: "make it more realistic",
      cfg: {},
      aspectRatio: "16:9",
      resolution: "2K",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/jpeg" }],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/xai/grok-imagine-image/edit",
      body: {
        prompt: "make it more realistic",
        aspect_ratio: "16:9",
        resolution: "2k",
        num_images: 1,
        output_format: "png",
        image_urls: [`data:image/jpeg;base64,${Buffer.from("source").toString("base64")}`],
      },
    });
  });

  it("rejects 4K resolution for Grok Imagine edits", async () => {
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
        model: "xai/grok-imagine-image",
        prompt: "too big",
        cfg: {},
        aspectRatio: "1:1",
        resolution: "4K",
        inputImages: [{ buffer: Buffer.from("src"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("fal Grok Imagine supports resolution values: 1K, 2K");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects Nano Banana ratios for Grok Imagine", async () => {
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
        model: "xai/grok-imagine-image",
        prompt: "unsupported ratio",
        cfg: {},
        aspectRatio: "21:9",
      }),
    ).rejects.toThrow("fal Grok Imagine supports aspectRatio values");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects Grok Imagine edits above 3 reference images", async () => {
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
        model: "xai/grok-imagine-image",
        prompt: "too many references",
        cfg: {},
        inputImages: Array.from({ length: 4 }, () => ({
          buffer: Buffer.from("ref"),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow("fal Grok Imagine supports at most 3 reference images");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("preserves an explicit Grok Imagine /quality/edit model path", async () => {
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
            images: [{ url: "https://v3.fal.media/files/example/grok-explicit.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("grok-explicit-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "xai/grok-imagine-image/quality/edit",
      prompt: "explicit edit endpoint",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/xai/grok-imagine-image/quality/edit",
      body: {
        prompt: "explicit edit endpoint",
        num_images: 1,
        output_format: "png",
        image_urls: [`data:image/png;base64,${Buffer.from("source").toString("base64")}`],
      },
    });
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
