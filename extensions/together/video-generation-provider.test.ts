// Together tests cover video generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildTogetherVideoGenerationProvider: typeof import("./video-generation-provider.js").buildTogetherVideoGenerationProvider;

beforeAll(async () => {
  ({ buildTogetherVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstPostJsonRequest(label: string): Record<string, unknown> {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return requireRecord(call[0], label);
}

function streamingResponse(params: {
  body: string;
  headers?: HeadersInit;
  onCancel: () => void;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
    },
    cancel() {
      params.onCancel();
    },
  });
  return new Response(stream, { headers: params.headers });
}

describe("together video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildTogetherVideoGenerationProvider());
  });

  it("creates a video, polls completion, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
          status: "in_progress",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireFirstPostJsonRequest("Together request");
    expect(request.url).toBe("https://api.together.xyz/v2/videos");
    const body = requireRecord(request.body, "Together request body");
    expect(body.model).toBe("Wan-AI/Wan2.2-T2V-A14B");
    expect(body.prompt).toBe("A bicycle weaving through a rainy neon street");
    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated Together video");
    }
    expect(video.fileName).toBe("video-1.webm");
    expect(result.metadata).toEqual({
      videoId: "video_123",
      status: "completed",
      videoUrl: "https://example.com/together.mp4",
    });
  });

  it("bounds downloaded videos before materializing them", async () => {
    let canceled = false;
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_oversized",
          status: "in_progress",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_oversized",
          status: "completed",
          outputs: { video_url: "https://example.com/oversized.mp4" },
        }),
      })
      .mockResolvedValueOnce(
        streamingResponse({
          body: "x".repeat(32),
          headers: { "content-type": "video/mp4" },
          onCancel: () => {
            canceled = true;
          },
        }),
      );

    const provider = buildTogetherVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "oversized video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.00001 } } },
      }),
    ).rejects.toThrow("Together generated video download exceeds");
    expect(canceled).toBe(true);
  });

  it("uses the video API endpoint when the shared Together text base URL is configured", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {
        models: {
          providers: {
            together: {
              baseUrl: "https://api.together.xyz/v1",
              models: [],
            },
          },
        },
      },
    });

    const request = requireFirstPostJsonRequest("Together request");
    expect(request.url).toBe("https://api.together.xyz/v2/videos");
  });

  it("drops out-of-range duration values before creating videos", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A bicycle weaving through a rainy neon street",
      durationSeconds: 99,
      cfg: {},
    });

    const request = requireFirstPostJsonRequest("Together request");
    const body = requireRecord(request.body, "Together request body");
    expect(body).not.toHaveProperty("seconds");
  });

  it("rejects reference images for Together text-to-video models before calling the API", async () => {
    const provider = buildTogetherVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "A bicycle weaving through a rainy neon street",
        cfg: {},
        inputImages: [
          {
            buffer: Buffer.from("png"),
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      }),
    ).rejects.toThrow(/does not support image reference inputs/u);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("sends reference images for the Together image-to-video model", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-I2V-A14B",
      prompt: "Animate the reference art.",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("png"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
    });

    const request = requireFirstPostJsonRequest("Together request");
    const body = requireRecord(request.body, "Together request body");
    expect(body.model).toBe("Wan-AI/Wan2.2-I2V-A14B");
    expect(body.reference_images).toHaveLength(1);
  });
});
