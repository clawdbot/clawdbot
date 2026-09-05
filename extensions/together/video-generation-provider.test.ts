import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest as requireFirstPostJsonRequest,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
// Together tests cover video generation provider plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildTogetherVideoGenerationProvider: typeof import("./video-generation-provider.js").buildTogetherVideoGenerationProvider;

beforeAll(async () => {
  ({ buildTogetherVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

const requireRecord = createRequireRecord("record", "expected-label-record");

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

  it("uses Together's canonical video model ids", () => {
    expect(buildTogetherVideoGenerationProvider().models).toEqual([
      "Wan-AI/Wan2.2-T2V-A14B",
      "Wan-AI/Wan2.2-I2V-A14B",
      "minimax/hailuo-02",
      "kwaivgI/kling-2.1-master",
    ]);
  });

  it("creates a video, polls completion, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "video_123",
        status: "in_progress",
      }),
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
    const request = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
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

  it.each(["video_failed", undefined])(
    "surfaces an immediately failed Together submission before polling or validating id (%s)",
    async (videoId) => {
      const release = vi.fn(async () => {});
      postJsonRequestMock.mockResolvedValue({
        response: streamedJsonResponse({
          ...(videoId ? { id: videoId } : {}),
          status: "failed",
          error: { message: "Together video quota exhausted" },
        }),
        release,
      });

      await expect(
        buildTogetherVideoGenerationProvider().generateVideo({
          provider: "together",
          model: "Wan-AI/Wan2.2-T2V-A14B",
          prompt: "A scene that cannot be generated",
          cfg: {},
        }),
      ).rejects.toThrow("Together video quota exhausted");

      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("uses an actionable fallback when an immediately failed submission omits its error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ status: "failed", error: null }),
      release,
    });

    await expect(
      buildTogetherVideoGenerationProvider().generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "A scene that cannot be generated",
        cfg: {},
      }),
    ).rejects.toThrow("Together video generation failed");

    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces provider errors from a failed poll and releases the submission", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "video_failed_later", status: "in_progress" }),
      release,
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        id: "video_failed_later",
        status: "failed",
        error: { message: "Together video content policy blocked this prompt" },
      }),
    });

    await expect(
      buildTogetherVideoGenerationProvider().generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "A scene that fails after submission",
        cfg: {},
      }),
    ).rejects.toThrow("Together video content policy blocked this prompt");

    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("downloads an immediately completed Together submission without polling it again", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "video_completed",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        status: "completed",
        outputs: { video_url: "https://example.com/completed.mp4" },
      }),
      release,
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      headers: new Headers({ "content-type": "video/mp4" }),
      arrayBuffer: async () => Buffer.from("completed-video"),
    });

    const result = await buildTogetherVideoGenerationProvider().generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A scene already generated",
      cfg: {},
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "Wan-AI/Wan2.2-T2V-A14B",
      metadata: { status: "completed", videoId: "video_completed" },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an immediately completed submission without a generated video URL", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "video_missing_output", status: "completed" }),
      release,
    });

    await expect(
      buildTogetherVideoGenerationProvider().generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "A completed scene without media",
        cfg: {},
      }),
    ).rejects.toThrow("Together video generation completed without an output URL");

    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded successful Together create JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue({
      response: oversized.response,
      release: vi.fn(async () => {}),
    });

    const provider = buildTogetherVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "together",
        model: "Wan-AI/Wan2.2-T2V-A14B",
        prompt: "oversized create body",
        cfg: {},
      }),
    ).rejects.toThrow("Together video generation failed: JSON response exceeds 16777216 bytes");
    // The bounded reader cancelled the stream rather than buffering the whole
    // body, and stopped reading well before the 64 MiB ceiling.
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("bounds downloaded videos before materializing them", async () => {
    let canceled = false;
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "video_oversized",
        status: "in_progress",
      }),
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
      response: streamedJsonResponse({
        id: "video_123",
      }),
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

    const request = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(request.url).toBe("https://api.together.xyz/v2/videos");
  });

  it("drops out-of-range duration values before creating videos", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "video_123",
      }),
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

    const request = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
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
      response: streamedJsonResponse({
        id: "video_123",
      }),
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

    const request = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    const body = requireRecord(request.body, "Together request body");
    const media = requireRecord(body.media, "Together video media payload");
    expect(body.model).toBe("Wan-AI/Wan2.2-I2V-A14B");
    expect(media.reference_images).toHaveLength(1);
    expect(body).not.toHaveProperty("reference_images");
  });
});
