import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
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
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: params.bytes }));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
    _setFalVideoFetchGuardForTesting(null);
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildFalVideoGenerationProvider());
  });

  it("submits fal video jobs through the queue API and downloads the completed result", async () => {
    mockFalProviderRuntime();
    mockCompletedFalVideoJob({
      requestId: "req-123",
      statusUrl: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
      responseUrl: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
      videoUrl: "https://fal.run/files/video.mp4",
      bytes: "mp4-bytes",
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

    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/video-01-live",
      }),
    );
    const submitBody = JSON.parse(
      String(fetchGuardMock.mock.calls[0]?.[0]?.init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
      prompt: "A spaceship emerges from the clouds",
    });
    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
      }),
    );
    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      requestId: "req-123",
    });
  });

  it("exposes Seedance 2 models", () => {
    const provider = buildFalVideoGenerationProvider();

    expect(provider.models).toEqual(
      expect.arrayContaining([
        "fal-ai/heygen/v2/video-agent",
        "bytedance/seedance-2.0/fast/text-to-video",
        "bytedance/seedance-2.0/fast/image-to-video",
        "bytedance/seedance-2.0/text-to-video",
        "bytedance/seedance-2.0/image-to-video",
      ]),
    );
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

    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/heygen/v2/video-agent",
      }),
    );
    const submitBody = JSON.parse(
      String(fetchGuardMock.mock.calls[0]?.[0]?.init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
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

    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video",
      }),
    );
    const submitBody = JSON.parse(
      String(fetchGuardMock.mock.calls[0]?.[0]?.init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
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
});
