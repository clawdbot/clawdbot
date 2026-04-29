import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterVideoGenerationProvider } from "./video-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  fetchWithTimeoutGuardedMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollIntervalMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  fetchWithTimeoutGuardedMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
    requestConfig: {},
  })),
  waitProviderOperationPollIntervalMock: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    ...actual,
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
    postJsonRequest: postJsonRequestMock,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
    waitProviderOperationPollInterval: waitProviderOperationPollIntervalMock,
  };
});

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

describe("openrouter video generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    fetchWithTimeoutGuardedMock.mockReset();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    waitProviderOperationPollIntervalMock.mockClear();
  });

  it("declares explicit mode capabilities", () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.id).toBe("openrouter");
    expect(provider.defaultModel).toBe("google/veo-3.1-fast");
    expect(provider.capabilities.generate?.supportsAudio).toBe(true);
    expect(provider.capabilities.generate?.supportedDurationSeconds).toEqual([4, 6, 8]);
    expect(provider.capabilities.generate?.resolutions).toEqual(["720P", "1080P"]);
    expect(provider.capabilities.generate?.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(provider.capabilities.imageToVideo?.enabled).toBe(true);
    expect(provider.capabilities.videoToVideo?.enabled).toBe(false);
  });

  it("submits OpenRouter video jobs, polls completion, and downloads the result", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "/api/v1/videos/job-123",
        status: "pending",
      }),
    );
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          generation_id: "gen-123",
          status: "completed",
          model: "google/veo-3.1",
          unsigned_urls: ["/api/v1/videos/job-123/content?index=0"],
          usage: { cost: 0.25, is_byok: false },
        }),
      )
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }));

    const requestOverrides = {
      proxy: { mode: "explicit-proxy", url: "https://proxy.example" },
    };
    const provider = buildOpenRouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A chrome sphere glides across a quiet moonlit beach",
      durationSeconds: 5.4,
      aspectRatio: "16:9",
      resolution: "720P",
      size: "1280x720",
      audio: false,
      inputImages: [
        { buffer: Buffer.from("first-frame"), mimeType: "image/png" },
        { buffer: Buffer.from("last-frame"), mimeType: "image/png", role: "last_frame" },
        {
          buffer: Buffer.from("style-reference"),
          mimeType: "image/webp",
          role: "reference_image",
        },
      ],
      providerOptions: {
        callback_url: "https://example.com/openrouter-video-hook",
        seed: 42,
      },
      timeoutMs: 120_000,
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              request: requestOverrides,
            },
          },
        },
      } as never,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        capability: "video",
        baseUrl: "https://custom.openrouter.test/api/v1",
        request: requestOverrides,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://custom.openrouter.test/api/v1/videos",
        body: {
          model: "google/veo-3.1",
          prompt: "A chrome sphere glides across a quiet moonlit beach",
          duration: 6,
          resolution: "720p",
          aspect_ratio: "16:9",
          size: "1280x720",
          generate_audio: false,
          frame_images: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from("first-frame").toString("base64")}`,
              },
              frame_type: "first_frame",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from("last-frame").toString("base64")}`,
              },
              frame_type: "last_frame",
            },
          ],
          input_references: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/webp;base64,${Buffer.from("style-reference").toString("base64")}`,
              },
            },
          ],
          callback_url: "https://example.com/openrouter-video-hook",
          seed: 42,
        },
      }),
    );
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      1,
      "https://custom.openrouter.test/api/v1/videos/job-123",
      expect.objectContaining({ method: "GET" }),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ auditContext: "openrouter-video-status" }),
    );
    expect(
      (fetchWithTimeoutGuardedMock.mock.calls[0]?.[1]?.headers as Headers | undefined)?.get(
        "authorization",
      ),
    ).toBe("Bearer openrouter-key");
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      2,
      "https://custom.openrouter.test/api/v1/videos/job-123/content?index=0",
      expect.objectContaining({ method: "GET" }),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ auditContext: "openrouter-video-download" }),
    );
    expect(
      (fetchWithTimeoutGuardedMock.mock.calls[1]?.[1]?.headers as Headers | undefined)?.get(
        "authorization",
      ),
    ).toBe("Bearer openrouter-key");
    expect(result.videos[0]?.buffer?.toString()).toBe("mp4-bytes");
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-123",
      status: "completed",
      generationId: "gen-123",
      usage: { cost: 0.25, is_byok: false },
    });
  });

  it("does not forward auth headers to cross-origin polling URLs", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://polling.example.test/videos/job-123",
        status: "pending",
      }),
    );
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        releasedJson({
          id: "job-123",
          status: "completed",
          unsigned_urls: ["https://cdn.openrouter.test/video.mp4"],
        }),
      )
      .mockResolvedValueOnce(releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }));

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A gentle camera pan across a neon reef",
      cfg: {} as never,
    });

    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      1,
      "https://polling.example.test/videos/job-123",
      expect.objectContaining({ method: "GET" }),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ auditContext: "openrouter-video-status" }),
    );
    expect(
      (fetchWithTimeoutGuardedMock.mock.calls[0]?.[1]?.headers as Headers | undefined)?.get(
        "authorization",
      ),
    ).toBeNull();
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      2,
      "https://cdn.openrouter.test/video.mp4",
      expect.objectContaining({ method: "GET" }),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ auditContext: "openrouter-video-download" }),
    );
    expect(
      (fetchWithTimeoutGuardedMock.mock.calls[1]?.[1]?.headers as Headers | undefined)?.get(
        "authorization",
      ),
    ).toBeNull();
  });

  it("falls back to the documented content endpoint when a completed job has no output URL", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        id: "job-123",
        polling_url: "https://openrouter.ai/api/v1/videos/job-123",
        status: "completed",
      }),
    );
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      releasedVideo({ contentType: "video/mp4", bytes: "mp4-bytes" }),
    );

    const provider = buildOpenRouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A tiny robot watering a bonsai",
      cfg: {} as never,
    });

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
      expect.objectContaining({ method: "GET" }),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ auditContext: "openrouter-video-download" }),
    );
    expect(result.videos[0]?.buffer?.toString()).toBe("mp4-bytes");
  });

  it("rejects video reference inputs", async () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openrouter",
        model: "google/veo-3.1",
        prompt: "remix this clip",
        inputVideos: [{ url: "https://example.com/source.mp4", mimeType: "video/mp4" }],
        cfg: {} as never,
      }),
    ).rejects.toThrow("does not support video reference inputs");
  });
});
