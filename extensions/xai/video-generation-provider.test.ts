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

function requirePostJsonCall(index = 0): {
  url?: string;
  body?: Record<string, unknown>;
} {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[unknown]>)[index]?.[0] as
    | {
        url?: string;
        body?: Record<string, unknown>;
      }
    | undefined;
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

function requireFetchInitCall(index: number): {
  url?: string;
  init?: { method?: string };
  timeoutMs?: number;
} {
  const call = (
    fetchWithTimeoutMock.mock.calls as unknown as Array<[string, { method?: string }, number]>
  )[index];
  if (!call) {
    throw new Error(`Expected fetchWithTimeout call ${index}`);
  }
  return {
    url: call[0],
    init: call[1],
    timeoutMs: call[2],
  };
}

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
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
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

    const createRequest = requirePostJsonCall();
    expect(createRequest.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(createRequest.body?.model).toBe("grok-imagine-video");
    expect(createRequest.body?.prompt).toBe("A tiny robot crab crossing a moonlit tide pool");
    expect(createRequest.body?.duration).toBe(6);
    expect(createRequest.body?.aspect_ratio).toBe("16:9");
    expect(createRequest.body?.resolution).toBe("720p");
    const pollRequest = requireFetchInitCall(0);
    expect(pollRequest.url).toBe("https://api.x.ai/v1/videos/req_123");
    expect(pollRequest.init?.method).toBe("GET");
    expect(pollRequest.timeoutMs).toBe(120000);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.requestId).toBe("req_123");
    expect(result.metadata?.mode).toBe("generate");
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

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/generations");
    const image = request.body?.image as { url?: string } | undefined;
    expect(image?.url).toMatch(/^data:image\/png;base64,/u);
    const body = request.body ?? {};
    expect(body).not.toHaveProperty("reference_images");
    expect(result.metadata?.mode).toBe("generate");
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

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(request.body?.reference_images).toEqual([
      { url: "https://example.com/subject.png" },
      { url: "https://example.com/style.png" },
    ]);
    expect(request.body?.duration).toBe(10);
    expect(request.body?.aspect_ratio).toBe("9:16");
    expect(request.body?.resolution).toBe("720p");
    const body = request.body ?? {};
    expect(body).not.toHaveProperty("image");
    expect(result.metadata?.mode).toBe("referenceToVideo");
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

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/extensions");
    expect(request.body?.video).toEqual({ url: "https://example.com/input.mp4" });
    expect(request.body?.duration).toBe(8);
  });
});
