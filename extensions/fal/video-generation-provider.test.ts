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

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
    _setFalVideoFetchGuardForTesting(null);
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildFalVideoGenerationProvider());
  });

  it("submits fal video jobs through the queue API and downloads the completed result", async () => {
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
    fetchGuardMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            request_id: "req-123",
            status_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
            response_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
            response: {
              video: { url: "https://fal.run/files/video.mp4" },
            },
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("mp4-bytes"),
        },
        release: vi.fn(async () => {}),
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
    fetchGuardMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            request_id: "heygen-req-123",
            status_url:
              "https://queue.fal.run/fal-ai/heygen/v2/video-agent/requests/heygen-req-123/status",
            response_url:
              "https://queue.fal.run/fal-ai/heygen/v2/video-agent/requests/heygen-req-123",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
            response: {
              video: { url: "https://fal.run/files/heygen.mp4" },
            },
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("heygen-mp4-bytes"),
        },
        release: vi.fn(async () => {}),
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
    fetchGuardMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            request_id: "seedance-req-123",
            status_url:
              "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-req-123/status",
            response_url:
              "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-req-123",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
            response: {
              video: { url: "https://fal.run/files/seedance.mp4" },
              seed: 42,
            },
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("seedance-mp4-bytes"),
        },
        release: vi.fn(async () => {}),
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
