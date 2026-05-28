import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
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

describe("pixverse video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildPixVerseVideoGenerationProvider());
  });

  it("submits text-to-video, polls status, and returns the output URL", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: {
          id: 123,
          status: 1,
          url: "https://media.pixverse.ai/out.mp4",
          seed: 42,
          outputWidth: 960,
          outputHeight: 540,
        },
      }),
      headers: new Headers(),
    });

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

  it("uploads local image input before submitting image-to-video", async () => {
    postMultipartRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { img_id: 456, img_url: "https://media.pixverse.ai/image.png" },
        }),
      },
      release: vi.fn(async () => {}),
    });
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 789 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: { id: 789, status: 1, url: "https://media.pixverse.ai/i2v.mp4" },
      }),
      headers: new Headers(),
    });

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
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { img_id: 111 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 222 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        ErrCode: 0,
        ErrMsg: "success",
        Resp: { id: 222, status: 1, url: "https://media.pixverse.ai/remote.mp4" },
      }),
      headers: new Headers(),
    });

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
      response: {
        json: async () => ({
          ErrCode: 400017,
          ErrMsg: "Invalid parameter",
        }),
      },
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
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 333 },
        }),
      },
      release: vi.fn(async () => {}),
    });
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

  it("uses configured baseUrl", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
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
      prompt: "custom base",
      cfg: {
        models: {
          providers: {
            pixverse: {
              baseUrl: "https://proxy.example/openapi/v2",
            },
          },
        },
      } as never,
    });

    expect(firstPostJsonRequest().url).toBe("https://proxy.example/openapi/v2/video/text/generate");
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(
      "https://proxy.example/openapi/v2/video/result/123",
    );
  });

  it("uses the guarded provider transport for status polling", async () => {
    const dispatcherPolicy = { mode: "direct" };
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://proxy.example/openapi/v2",
      allowPrivateNetwork: true,
      headers: new Headers({ "API-KEY": "provider-key", "X-Proxy": "enabled" }),
      dispatcherPolicy,
    } as never);
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
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
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
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
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
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

  it("uses the configured CN API region", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
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
      prompt: "cn endpoint",
      cfg: {
        models: {
          providers: {
            pixverse: {
              region: "cn",
            },
          },
        },
      } as never,
    });

    expect(firstPostJsonRequest().url).toBe(
      "https://app-api.pixverseai.cn/openapi/v2/video/text/generate",
    );
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(
      "https://app-api.pixverseai.cn/openapi/v2/video/result/123",
    );
  });

  it("prefers configured baseUrl over API region", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          ErrCode: 0,
          ErrMsg: "success",
          Resp: { video_id: 123 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
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
      prompt: "custom base",
      cfg: {
        models: {
          providers: {
            pixverse: {
              baseUrl: "https://proxy.example/openapi/v2",
              region: "cn",
            },
          },
        },
      } as never,
    });

    expect(firstPostJsonRequest().url).toBe("https://proxy.example/openapi/v2/video/text/generate");
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(
      "https://proxy.example/openapi/v2/video/result/123",
    );
  });
});
