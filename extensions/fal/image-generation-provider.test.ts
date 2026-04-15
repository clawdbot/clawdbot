import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

import {
  _setFalFetchGuardForTesting,
  buildFalImageGenerationProvider,
} from "./image-generation-provider.js";

function expectFalJsonPost(params: { call: number; url: string; body: Record<string, unknown> }) {
  const request = fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0];
  expect(request).toBeTruthy();
  expect(request?.url).toBe(params.url);
  expect(request?.auditContext).toBe("fal-image-generate");
  expect(request?.init?.method).toBe("POST");
  const headers = new Headers(request?.init?.headers);
  expect(headers.get("authorization")).toBe("Key fal-test-key");
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(String(request?.init?.body))).toEqual(params.body);
}

describe("fal image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setFalFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("generates image buffers from the fal sync API", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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
    });

    expectFalJsonPost({
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        image_size: { width: 1536, height: 1024 },
        num_images: 2,
        output_format: "png",
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://v3.fal.media/files/example/generated.png",
        auditContext: "fal-image-download",
        policy: undefined,
      }),
    );
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

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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

  it("maps aspect ratio for text generation without forcing a square default", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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

  it("rejects multi-image edit requests for now", async () => {
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

  it("rejects aspect ratio overrides for the current edit endpoint", async () => {
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
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        auditContext: "fal-image-download",
        policy: undefined,
      }),
    );
  });

  it("does not auto-whitelist trusted private relay hosts from a configured baseUrl", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "http://relay.internal:8080/fal-ai/flux/dev",
        auditContext: "fal-image-generate",
        policy: undefined,
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://media.relay.internal/files/generated.png",
        auditContext: "fal-image-download",
        policy: undefined,
      }),
    );
  });
});
