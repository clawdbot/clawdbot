import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

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
