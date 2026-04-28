import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildXaiVideoGenerationProvider: typeof import("./video-generation-provider.js").buildXaiVideoGenerationProvider;

beforeAll(async () => {
  ({ buildXaiVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("xai video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildXaiVideoGenerationProvider());
  });

  it("creates, polls, and downloads a generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_123",
          status: "done",
          video: { url: "https://cdn.x.ai/video.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "A tiny robot crab crossing a moonlit tide pool",
      cfg: {},
      durationSeconds: 6,
      aspectRatio: "16:9",
      resolution: "720P",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/generations",
        body: expect.objectContaining({
          model: "grok-imagine-video",
          prompt: "A tiny robot crab crossing a moonlit tide pool",
          duration: 6,
          aspect_ratio: "16:9",
          resolution: "720p",
        }),
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.x.ai/v1/videos/req_123",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        requestId: "req_123",
        mode: "generate",
      }),
    );
  });

  it("sends a single unroled image as xAI first-frame image-to-video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_image",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_image",
          status: "done",
          video: { url: "https://cdn.x.ai/image-video.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("image-video-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Animate this logo into a clean bumper",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    const body = postJsonRequestMock.mock.calls[0]?.[0]?.body as Record<string, unknown>;
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/generations",
        body: expect.objectContaining({
          image: {
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        }),
      }),
    );
    expect(body).not.toHaveProperty("reference_images");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        mode: "generate",
      }),
    );
  });

  it("sends reference_image roles through xAI reference_images mode", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_refs",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_refs",
          status: "done",
          video: { url: "https://cdn.x.ai/reference-video.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("reference-video-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Make a cinematic brand vignette using these references",
      cfg: {},
      durationSeconds: 12,
      aspectRatio: "9:16",
      resolution: "720P",
      inputImages: [
        { url: "https://example.com/subject.png", role: "reference_image" },
        { url: "https://example.com/style.png", role: "reference_image" },
      ],
    });

    const body = postJsonRequestMock.mock.calls[0]?.[0]?.body as Record<string, unknown>;
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/generations",
        body: expect.objectContaining({
          reference_images: [
            { url: "https://example.com/subject.png" },
            { url: "https://example.com/style.png" },
          ],
          duration: 10,
          aspect_ratio: "9:16",
          resolution: "720p",
        }),
      }),
    );
    expect(body).not.toHaveProperty("image");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        mode: "referenceToVideo",
      }),
    );
  });

  it("rejects mixed xAI first-frame and reference-image roles", async () => {
    const provider = buildXaiVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "Use both images",
        cfg: {},
        inputImages: [
          { url: "https://example.com/subject.png", role: "reference_image" },
          { url: "https://example.com/first-frame.png", role: "first_frame" },
        ],
      }),
    ).rejects.toThrow(
      "xAI reference-image video generation requires every image role to be reference_image.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("routes video inputs to the extension endpoint when duration is set", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_extend",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_extend",
          status: "done",
          video: { url: "https://cdn.x.ai/extended.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("extended-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Continue the shot into a neon alleyway",
      cfg: {},
      durationSeconds: 8,
      inputVideos: [{ url: "https://example.com/input.mp4" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/extensions",
        body: expect.objectContaining({
          video: { url: "https://example.com/input.mp4" },
          duration: 8,
        }),
      }),
    );
  });
});
