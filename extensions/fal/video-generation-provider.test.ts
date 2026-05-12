import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _setFalVideoFetchGuardForTesting,
  buildFalVideoGenerationProvider,
} from "./video-generation-provider.js";

function createMockRequestConfig() {
  return {} as ReturnType<typeof providerHttp.resolveProviderHttpRequestConfig>["requestConfig"];
}
describe("fal video generation provider", () => {
  const fetchGuardMock = vi.fn();

  function mockFalProviderRuntime() {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-key",
      source: "env",
      mode: "api-key",
    });
    vi.spyOn(providerHttp, "resolveProviderHttpRequestConfig").mockReturnValue({
      baseUrl: "https://fal.run",
      allowPrivateNetwork: false,
      headers: new Headers({
        Authorization: "Key fal-key",
        "Content-Type": "application/json",
      }),
      dispatcherPolicy: undefined,
      requestConfig: createMockRequestConfig(),
    });
    vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);
    _setFalVideoFetchGuardForTesting(fetchGuardMock as never);
  }

  function releasedJson(value: unknown) {
    return {
      response: {
        json: async () => value,
      },
      release: vi.fn(async () => {}),
    };
  }

  function releasedVideo(params: { contentType: string; bytes: string }) {
    return {
      response: {
        headers: new Headers({ "content-type": params.contentType }),
        arrayBuffer: async () => Buffer.from(params.bytes),
      },
      release: vi.fn(async () => {}),
    };
  }

  function mockCompletedFalVideoJob(params: {
    requestId: string;
    statusUrl: string;
    responseUrl: string;
    videoUrl: string;
    bytes: string;
    contentType?: string;
    responseExtras?: Record<string, unknown>;
  }) {
    fetchGuardMock
      .mockResolvedValueOnce(
        releasedJson({
          request_id: params.requestId,
          status_url: params.statusUrl,
          response_url: params.responseUrl,
        }),
      )
      .mockResolvedValueOnce(releasedJson({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        releasedJson({
          status: "COMPLETED",
          response: {
            video: { url: params.videoUrl },
            ...params.responseExtras,
          },
        }),
      )
      .mockResolvedValueOnce(
        releasedVideo({ contentType: params.contentType ?? "video/mp4", bytes: params.bytes }),
      );
  }

  function requireFetchGuardCall(callNumber: number): { init?: RequestInit; url?: string } {
    const call = fetchGuardMock.mock.calls[callNumber - 1];
    if (!call) {
      throw new Error(`expected fal fetch guard call ${callNumber}`);
    }
    const [request] = call;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error(`expected fal fetch guard request ${callNumber}`);
    }
    return request as { init?: RequestInit; url?: string };
  }

  function getSubmitBody(): Record<string, unknown> {
    const body = requireFetchGuardCall(1).init?.body;
    if (typeof body !== "string") {
      throw new Error("expected fal submit JSON body");
    }
    return JSON.parse(body) as Record<string, unknown>;
  }

  function fetchGuardUrl(callNumber: number): string | undefined {
    return requireFetchGuardCall(callNumber).url;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
    _setFalVideoFetchGuardForTesting(null);
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildFalVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.imageToVideo?.maxInputImages).toBe(1);
    expect(
      provider.capabilities.imageToVideo?.maxInputImagesByModel?.[
        "bytedance/seedance-2.0/fast/reference-to-video"
      ],
    ).toBe(9);
    expect(provider.capabilities.videoToVideo?.maxInputVideos).toBe(0);
    expect(
      Object.keys(provider.capabilities.videoToVideo?.supportedDurationSecondsByModel ?? {}),
    ).toEqual([
      "bytedance/seedance-2.0/fast/reference-to-video",
      "bytedance/seedance-2.0/reference-to-video",
    ]);
  });

  it("submits fal video jobs through the queue API and downloads the completed result", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "req-123",
      statusUrl: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
      responseUrl: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
      videoUrl: "https://fal.run/files/video.mp4",
      bytes: "webm-bytes",
      contentType: "video/webm",
    });

    const provider = buildFalVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "fal",
      model: "fal-ai/minimax/video-01-live",
      prompt: "A spaceship emerges from the clouds",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720P",
      cfg: {},
    });

    expect(fetchGuardUrl(1)).toBe("https://queue.fal.run/fal-ai/minimax/video-01-live");
    const submitBody = getSubmitBody();
    expect(submitBody).toEqual({
      prompt: "A spaceship emerges from the clouds",
    });
    expect(fetchGuardUrl(2)).toBe("https://queue.fal.run/fal-ai/minimax/requests/req-123/status");
    expect(fetchGuardUrl(3)).toBe("https://queue.fal.run/fal-ai/minimax/requests/req-123");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.videos[0]?.url).toBe("https://fal.run/files/video.mp4");
    expect(result.metadata).toEqual({
      requestId: "req-123",
    });
  });

  it("exposes Seedance 2 models", () => {
    const provider = buildFalVideoGenerationProvider();

    expect(provider.models).toContain("fal-ai/heygen/v2/video-agent");
    expect(provider.models).toContain("bytedance/seedance-2.0/fast/text-to-video");
    expect(provider.models).toContain("bytedance/seedance-2.0/fast/image-to-video");
    expect(provider.models).toContain("bytedance/seedance-2.0/fast/reference-to-video");
    expect(provider.models).toContain("bytedance/seedance-2.0/text-to-video");
    expect(provider.models).toContain("bytedance/seedance-2.0/image-to-video");
    expect(provider.models).toContain("bytedance/seedance-2.0/reference-to-video");
  });

  it("submits HeyGen video-agent requests without unsupported fal controls", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "heygen-req-123",
      statusUrl:
        "https://queue.fal.run/fal-ai/heygen/v2/video-agent/requests/heygen-req-123/status",
      responseUrl: "https://queue.fal.run/fal-ai/heygen/v2/video-agent/requests/heygen-req-123",
      videoUrl: "https://fal.run/files/heygen.mp4",
      bytes: "heygen-mp4-bytes",
    });

    const provider = buildFalVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "fal",
      model: "fal-ai/heygen/v2/video-agent",
      prompt: "A founder explains OpenClaw in a concise studio video",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: true,
      cfg: {},
    });

    expect(fetchGuardUrl(1)).toBe("https://queue.fal.run/fal-ai/heygen/v2/video-agent");
    expect(getSubmitBody()).toEqual({
      prompt: "A founder explains OpenClaw in a concise studio video",
    });
    expect(result.metadata).toEqual({
      requestId: "heygen-req-123",
    });
  });

  it("submits Seedance 2 requests with fal schema fields", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "seedance-req-123",
      statusUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-req-123/status",
      responseUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-req-123",
      videoUrl: "https://fal.run/files/seedance.mp4",
      bytes: "seedance-mp4-bytes",
      responseExtras: { seed: 42 },
    });

    const provider = buildFalVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "fal",
      model: "bytedance/seedance-2.0/fast/text-to-video",
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      durationSeconds: 7,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: false,
      cfg: {},
    });

    expect(fetchGuardUrl(1)).toBe(
      "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video",
    );
    expect(getSubmitBody()).toEqual({
      prompt: "A chrome lobster drives a tiny kart across a neon pier",
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: "7",
      generate_audio: false,
    });
    expect(result.metadata).toEqual({
      requestId: "seedance-req-123",
      seed: 42,
    });
  });

  it("submits Seedance 2 image-to-video requests with a single image_url", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "seedance-i2v-req-123",
      statusUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/image-to-video/requests/seedance-i2v-req-123/status",
      responseUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/image-to-video/requests/seedance-i2v-req-123",
      videoUrl: "https://fal.run/files/seedance-i2v.mp4",
      bytes: "seedance-i2v-mp4-bytes",
    });

    const provider = buildFalVideoGenerationProvider();
    await provider.generateVideo({
      provider: "fal",
      model: "bytedance/seedance-2.0/fast/image-to-video",
      prompt: "Animate this product still with a slow orbit",
      durationSeconds: 6,
      inputImages: [{ url: "https://example.com/start-frame.png" }],
      cfg: {},
    });

    expect(getSubmitBody()).toEqual({
      prompt: "Animate this product still with a slow orbit",
      image_url: "https://example.com/start-frame.png",
      duration: "6",
    });
  });

  it("submits Seedance 2 reference-to-video requests with image, video, and audio URLs", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "seedance-ref-req-123",
      statusUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video/requests/seedance-ref-req-123/status",
      responseUrl:
        "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video/requests/seedance-ref-req-123",
      videoUrl: "https://fal.run/files/seedance-ref.mp4",
      bytes: "seedance-ref-mp4-bytes",
      responseExtras: { seed: 1234 },
    });

    const provider = buildFalVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "fal",
      model: "bytedance/seedance-2.0/fast/reference-to-video",
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "480P",
      audio: false,
      inputImages: [
        { url: "https://example.com/reference-1.png" },
        { buffer: Buffer.from("local-image"), mimeType: "image/webp" },
      ],
      inputVideos: [
        { url: "https://example.com/reference-1.mp4" },
        { buffer: Buffer.from("local-video"), mimeType: "video/quicktime" },
      ],
      inputAudios: [
        { url: "https://example.com/reference-1.mp3" },
        { buffer: Buffer.from("local-audio"), mimeType: "audio/wav" },
      ],
      cfg: {},
    });

    expect(fetchGuardUrl(1)).toBe(
      "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video",
    );
    expect(getSubmitBody()).toEqual({
      prompt: "Blend @Image1, @Image2, @Video1, @Video2, and @Audio1 into one short film",
      image_urls: [
        "https://example.com/reference-1.png",
        `data:image/webp;base64,${Buffer.from("local-image").toString("base64")}`,
      ],
      video_urls: [
        "https://example.com/reference-1.mp4",
        `data:video/quicktime;base64,${Buffer.from("local-video").toString("base64")}`,
      ],
      audio_urls: [
        "https://example.com/reference-1.mp3",
        `data:audio/wav;base64,${Buffer.from("local-audio").toString("base64")}`,
      ],
      aspect_ratio: "9:16",
      resolution: "480p",
      duration: "8",
      generate_audio: false,
    });
    expect(result.metadata).toEqual({
      requestId: "seedance-ref-req-123",
      seed: 1234,
    });
  });

  it("rejects video, audio, and multiple image references for non-reference fal models", async () => {
    const provider = buildFalVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "fal",
        model: "fal-ai/minimax/video-01-live",
        prompt: "Animate this",
        inputImages: [
          { url: "https://example.com/one.png" },
          { url: "https://example.com/two.png" },
        ],
        cfg: {},
      }),
    ).rejects.toThrow("fal video generation supports at most one image reference.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model: "fal-ai/minimax/video-01-live",
        prompt: "Animate this",
        inputVideos: [{ url: "https://example.com/reference.mp4" }],
        cfg: {},
      }),
    ).rejects.toThrow("fal video generation does not support video reference inputs.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model: "fal-ai/minimax/video-01-live",
        prompt: "Animate this",
        inputAudios: [{ url: "https://example.com/reference.mp3" }],
        cfg: {},
      }),
    ).rejects.toThrow("fal video generation does not support audio reference inputs.");
  });

  it("rejects over-limit and audio-only Seedance reference-to-video requests", async () => {
    const provider = buildFalVideoGenerationProvider();
    const model = "bytedance/seedance-2.0/fast/reference-to-video";

    await expect(
      provider.generateVideo({
        provider: "fal",
        model,
        prompt: "Too many images",
        inputImages: Array.from({ length: 10 }, (_, index) => ({
          url: `https://example.com/image-${index}.png`,
        })),
        cfg: {},
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 9 reference images.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model,
        prompt: "Too many videos",
        inputVideos: Array.from({ length: 4 }, (_, index) => ({
          url: `https://example.com/video-${index}.mp4`,
        })),
        cfg: {},
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 3 reference videos.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model,
        prompt: "Too many audios",
        inputAudios: Array.from({ length: 4 }, (_, index) => ({
          url: `https://example.com/audio-${index}.mp3`,
        })),
        cfg: {},
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 3 reference audios.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model,
        prompt: "Too many total files",
        inputImages: Array.from({ length: 9 }, (_, index) => ({
          url: `https://example.com/image-${index}.png`,
        })),
        inputVideos: Array.from({ length: 3 }, (_, index) => ({
          url: `https://example.com/video-${index}.mp4`,
        })),
        inputAudios: [{ url: "https://example.com/audio.mp3" }],
        cfg: {},
      }),
    ).rejects.toThrow("fal Seedance reference-to-video supports at most 12 total reference files.");

    await expect(
      provider.generateVideo({
        provider: "fal",
        model,
        prompt: "Audio only",
        inputAudios: [{ url: "https://example.com/audio.mp3" }],
        cfg: {},
      }),
    ).rejects.toThrow(
      "fal Seedance reference-to-video requires at least one image or video reference when audio references are provided.",
    );
  });
});
