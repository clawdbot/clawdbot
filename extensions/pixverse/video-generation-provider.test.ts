// Pixverse tests cover video generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock,
  postMultipartRequestMock,
  fetchWithTimeoutMock,
  pollProviderOperationJsonMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let buildPixVerseVideoGenerationProvider: typeof import("./video-generation-provider.js").buildPixVerseVideoGenerationProvider;

beforeAll(async () => {
  ({ buildPixVerseVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function firstPostJsonRequest() {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected PixVerse create request");
  }
  return call[0] as { url?: string; body?: Record<string, unknown>; headers?: Headers };
}

function firstMultipartRequest() {
  const [call] = postMultipartRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected PixVerse image upload request");
  }
  return call[0] as { url?: string; body?: FormData; headers?: Headers };
}

function firstPollRequest() {
  const [call] = pollProviderOperationJsonMock.mock.calls;
  if (!call) {
    throw new Error("expected PixVerse status poll request");
  }
  return call[0] as {
    url?: string;
    allowPrivateNetwork?: boolean;
    dispatcherPolicy?: unknown;
  };
}

function pollFetchHeaders(callIndex: number): Headers | undefined {
  const [, init] = fetchWithTimeoutMock.mock.calls[callIndex] ?? [];
  return (init as { headers?: Headers } | undefined)?.headers;
}

function mockPixVerseVideoSubmit(videoId = 123) {
  postJsonRequestMock.mockResolvedValue({
    response: streamedJsonResponse({
      ErrCode: 0,
      ErrMsg: "success",
      Resp: { video_id: videoId },
    }),
    release: vi.fn(async () => {}),
  });
}

function mockPixVerseVideoTask(
  params: {
    videoId?: number;
    videoUrl?: string;
    seed?: number;
    outputWidth?: number;
    outputHeight?: number;
  } = {},
) {
  const videoId = params.videoId ?? 123;
  mockPixVerseVideoSubmit(videoId);
  fetchWithTimeoutMock.mockResolvedValueOnce({
    json: async () => ({
      ErrCode: 0,
      ErrMsg: "success",
      Resp: {
        id: videoId,
        status: 1,
        url: params.videoUrl ?? "https://media.pixverse.ai/out.mp4",
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        ...(params.outputWidth === undefined ? {} : { outputWidth: params.outputWidth }),
        ...(params.outputHeight === undefined ? {} : { outputHeight: params.outputHeight }),
      },
    }),
    headers: new Headers(),
  });
}

describe("pixverse video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildPixVerseVideoGenerationProvider());
  });

  it("submits text-to-video, polls status, and returns the output URL", async () => {
    mockPixVerseVideoTask({ seed: 42, outputWidth: 960, outputHeight: 540 });

    const provider = buildPixVerseVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "pixverse",
      model: "pixverse/v6",
      prompt: "a tiny lobster DJ under neon lights",
      cfg: {},
      durationSeconds: 4,
      aspectRatio: "21:9",
      resolution: "720P",
      audio: true,
      providerOptions: {
        seed: 42,
        negativePrompt: "blur",
        cameraMovement: "zoom_in",
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const createRequest = firstPostJsonRequest();
    expect(createRequest.url).toBe("https://app-api.pixverse.ai/openapi/v2/video/text/generate");
    expect(createRequest.body).toEqual({
      duration: 4,
      model: "v6",
      prompt: "a tiny lobster DJ under neon lights",
      quality: "720p",
      aspect_ratio: "21:9",
      negative_prompt: "blur",
      camera_movement: "zoom_in",
      seed: 42,
      generate_audio_switch: true,
    });
    expect(createRequest.headers?.get("API-KEY")).toBe("provider-key");
    expect(createRequest.headers?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(
      "https://app-api.pixverse.ai/openapi/v2/video/result/123",
    );
    expect(result).toEqual({
      videos: [
        {
          url: "https://media.pixverse.ai/out.mp4",
          mimeType: "video/mp4",
          fileName: "video-1.mp4",
          metadata: {
            sourceUrl: "https://media.pixverse.ai/out.mp4",
            outputWidth: 960,
            outputHeight: 540,
          },
        },
      ],
      model: "v6",
      metadata: {
        endpoint: "/video/text/generate",
        videoId: 123,
        status: 1,
        seed: 42,
        size: undefined,
      },
    });
  });

  it("drops malformed seed values before creating videos", async () => {
    mockPixVerseVideoTask();

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "pixverse/v6",
      prompt: "a quiet city street at sunrise",
      cfg: {},
      providerOptions: {
        seed: 1.5,
      },
    });

    expect(firstPostJsonRequest().body).not.toHaveProperty("seed");
  });

  it("drops malformed response seed metadata", async () => {
    mockPixVerseVideoTask({ seed: 1.5 });

    const provider = buildPixVerseVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "pixverse",
      model: "pixverse/v6",
      prompt: "a quiet city street at sunrise",
      cfg: {},
    });

    expect(result.metadata).toEqual({
      endpoint: "/video/text/generate",
      videoId: 123,
      status: 1,
      seed: undefined,
      size: undefined,
    });
  });

  it("rejects fractional video ids before polling", async () => {
    mockPixVerseVideoSubmit(123.5);

    const provider = buildPixVerseVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "pixverse",
        model: "pixverse/v6",
        prompt: "a quiet city street at sunrise",
        cfg: {},
      }),
    ).rejects.toThrow("PixVerse video generation response missing video_id");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("bounds an unbounded successful PixVerse create JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue({
      response: oversized.response,
      release: vi.fn(async () => {}),
    });

    const provider = buildPixVerseVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "pixverse",
        model: "pixverse/v6",
        prompt: "oversized create body",
        cfg: {},
      }),
    ).rejects.toThrow("PixVerse video generation failed: JSON response exceeds 16777216 bytes");
    // The bounded reader cancelled the stream rather than buffering the whole
    // body, and stopped reading well before the 64 MiB ceiling.
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("bounds an unbounded successful PixVerse image upload JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postMultipartRequestMock.mockResolvedValue({
      response: oversized.response,
      release: vi.fn(async () => {}),
    });

    const provider = buildPixVerseVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "pixverse",
        model: "c1",
        prompt: "oversized upload body",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("PixVerse image upload failed: JSON response exceeds 16777216 bytes");
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("uploads local image input before submitting image-to-video", async () => {
    postMultipartRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: { img_id: 456, img_url: "https://media.pixverse.ai/image.png" },
      }),
      release: vi.fn(async () => {}),
    });
    mockPixVerseVideoTask({ videoId: 789, videoUrl: "https://media.pixverse.ai/i2v.mp4" });

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "c1",
      prompt: "animate the product",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      durationSeconds: 99,
      providerOptions: {
        motionMode: "fast",
        templateId: 302325299692608,
      },
    });

    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const uploadRequest = firstMultipartRequest();
    expect(uploadRequest.url).toBe("https://app-api.pixverse.ai/openapi/v2/image/upload");
    expect(uploadRequest.headers?.get("Content-Type")).toBeNull();
    expect(uploadRequest.body?.get("image")).toBeInstanceOf(File);

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const createRequest = firstPostJsonRequest();
    expect(createRequest.url).toBe("https://app-api.pixverse.ai/openapi/v2/video/img/generate");
    expect(createRequest.body).toEqual({
      duration: 15,
      model: "c1",
      prompt: "animate the product",
      quality: "540p",
      img_id: 456,
      motion_mode: "fast",
      template_id: 302325299692608,
    });
  });

  it("uploads remote image URLs through PixVerse image upload", async () => {
    postMultipartRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: { img_id: 111 },
      }),
      release: vi.fn(async () => {}),
    });
    mockPixVerseVideoTask({ videoId: 222, videoUrl: "https://media.pixverse.ai/remote.mp4" });

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "v6",
      prompt: "animate the remote image",
      cfg: {},
      inputImages: [{ url: "https://example.com/input.png" }],
    });

    const uploadRequest = firstMultipartRequest();
    expect(uploadRequest.body?.get("image_url")).toBe("https://example.com/input.png");
    const createRequest = firstPostJsonRequest();
    expect(createRequest.body?.img_id).toBe(111);
  });

  it("rejects PixVerse API errors before polling", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        ErrCode: 400017,
        ErrMsg: "Invalid parameter",
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildPixVerseVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "pixverse",
        model: "v6",
        prompt: "bad request",
        cfg: {},
      }),
    ).rejects.toThrow("PixVerse video generation failed: Invalid parameter");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("reports PixVerse moderation failures from status polling", async () => {
    mockPixVerseVideoSubmit(333);
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: { id: 333, status: 7 },
      }),
      headers: new Headers(),
    });

    const provider = buildPixVerseVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "pixverse",
        model: "v6",
        prompt: "moderated request",
        cfg: {},
      }),
    ).rejects.toThrow("PixVerse video generation failed content moderation");
  });

  it.each([
    {
      name: "uses configured baseUrl",
      providerConfig: { baseUrl: "https://proxy.example/openapi/v2" },
      expectedBaseUrl: "https://proxy.example/openapi/v2",
      prompt: "custom base",
    },
    {
      name: "uses the configured CN API region",
      providerConfig: { region: "cn" },
      expectedBaseUrl: "https://app-api.pixverseai.cn/openapi/v2",
      prompt: "cn endpoint",
    },
    {
      name: "prefers configured baseUrl over API region",
      providerConfig: { baseUrl: "https://proxy.example/openapi/v2", region: "cn" },
      expectedBaseUrl: "https://proxy.example/openapi/v2",
      prompt: "custom base",
    },
  ])("$name", async ({ providerConfig, expectedBaseUrl, prompt }) => {
    mockPixVerseVideoTask();

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "v6",
      prompt,
      cfg: {
        models: {
          providers: {
            pixverse: providerConfig,
          },
        },
      } as never,
    });

    expect(firstPostJsonRequest().url).toBe(`${expectedBaseUrl}/video/text/generate`);
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(`${expectedBaseUrl}/video/result/123`);
  });

  it("uses the guarded provider transport for status polling", async () => {
    const dispatcherPolicy = { mode: "direct" };
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://proxy.example/openapi/v2",
      allowPrivateNetwork: true,
      headers: new Headers({ "API-KEY": "provider-key", "X-Proxy": "enabled" }),
      dispatcherPolicy,
    } as never);
    mockPixVerseVideoTask();

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "v6",
      prompt: "custom base",
      cfg: {},
    });

    expect(firstPostJsonRequest().url).toBe("https://proxy.example/openapi/v2/video/text/generate");
    expect(firstPostJsonRequest().headers?.get("X-Proxy")).toBe("enabled");
    expect(firstPollRequest()).toMatchObject({
      url: "https://proxy.example/openapi/v2/video/result/123",
      allowPrivateNetwork: true,
      dispatcherPolicy,
    });
    const pollHeaders = pollFetchHeaders(0);
    expect(pollHeaders?.get("X-Proxy")).toBe("enabled");
  });

  it("passes configured provider request overrides into the HTTP resolver", async () => {
    const request = {
      allowPrivateNetwork: true,
      headers: { "X-Proxy": "enabled" },
    };
    mockPixVerseVideoTask();

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "v6",
      prompt: "custom request config",
      cfg: {
        models: {
          providers: {
            pixverse: {
              request,
            },
          },
        },
      } as never,
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith(request);
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ request }),
    );
  });

  it("uses a fresh trace id for each status poll", async () => {
    mockPixVerseVideoSubmit();
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { id: 123, status: 5 },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { id: 123, status: 1, url: "https://media.pixverse.ai/out.mp4" },
        }),
        headers: new Headers(),
      });

    const provider = buildPixVerseVideoGenerationProvider();
    await provider.generateVideo({
      provider: "pixverse",
      model: "v6",
      prompt: "fresh trace ids",
      cfg: {},
    });

    const firstHeaders = pollFetchHeaders(0);
    const secondHeaders = pollFetchHeaders(1);
    expect(firstHeaders?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHeaders?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHeaders?.get("Ai-trace-id")).not.toBe(firstHeaders?.get("Ai-trace-id"));
  });
});
