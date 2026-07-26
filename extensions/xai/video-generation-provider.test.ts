// Xai tests cover video generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock,
  fetchWithTimeoutGuardedMock,
  fetchWithTimeoutMock,
  readProviderJsonResponseMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let buildXaiVideoGenerationProvider: typeof import("./video-generation-provider.js").buildXaiVideoGenerationProvider;

beforeAll(async () => {
  ({ buildXaiVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

beforeEach(() => {
  readProviderJsonResponseMock.mockImplementation(async <T>(response: Response, label: string) => {
    const maxBytes = 16 * 1024 * 1024;
    if (!response.body) {
      try {
        return (await response.json()) as T;
      } catch (cause) {
        throw new Error(`${label}: malformed JSON response`, { cause });
      }
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`${label}: JSON response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(body)) as T;
    } catch (cause) {
      throw new Error(`${label}: malformed JSON response`, { cause });
    }
  });
});

function requirePostJsonCall(index = 0): {
  url?: string;
  body?: Record<string, unknown>;
  headers?: Headers;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: unknown;
} {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[unknown]>)[index]?.[0] as
    | {
        url?: string;
        body?: Record<string, unknown>;
        headers?: Headers;
        allowPrivateNetwork?: boolean;
        dispatcherPolicy?: unknown;
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

function streamedVideoResponse(bytes: string, contentType = "video/mp4"): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

function streamedJsonResponse(payload: unknown): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

// Drives an unbounded JSON body (>16 MiB, no Content-Length) so the bounded
// reader has to cancel the stream instead of buffering it all. The 1 MiB
// chunks are emitted lazily on `pull`, and a hard ceiling guards the test from
// hanging if the reader ever fails to cancel.
function oversizedJsonResponse(): {
  response: Response;
  state: { canceled: boolean; enqueuedBytes: number };
} {
  const state = { canceled: false, enqueuedBytes: 0 };
  const chunk = 1024 * 1024;
  // 64 MiB ceiling: 4x the 16 MiB cap, so the bounded reader must cancel long
  // before we run out of chunks.
  const maxChunks = 64;
  let emitted = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (emitted >= maxChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        state.enqueuedBytes += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        state.canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, state };
}

describe("xai video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    const provider = buildXaiVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.videoToVideo).toMatchObject({
      maxDurationSeconds: 10,
      supportsAspectRatio: false,
      supportsResolution: false,
    });
  });

  it("advertises canonical 1.5 and resolves capabilities for all API aliases", async () => {
    const provider = buildXaiVideoGenerationProvider();

    expect(provider.defaultModel).toBe("grok-imagine-video");
    expect(provider.models).toEqual(["grok-imagine-video", "grok-imagine-video-1.5"]);
    expect(provider.catalogByModel?.["grok-imagine-video-1.5"]).toMatchObject({
      modes: ["imageToVideo"],
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          resolutions: ["480P", "720P", "1080P"],
        },
        videoToVideo: { enabled: false },
      },
    });

    for (const model of [
      "grok-imagine-video-1.5",
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-1.5-2026-05-30",
    ]) {
      const capabilities = await provider.resolveModelCapabilities?.({
        provider: "xai",
        model,
        cfg: {},
      });
      expect(capabilities?.imageToVideo).toMatchObject({
        enabled: true,
        maxInputImages: 1,
        maxDurationSeconds: 15,
        resolutions: ["480P", "720P", "1080P"],
      });
      expect(capabilities?.videoToVideo?.enabled).toBe(false);
    }
  });

  it("uses the 1.5 default while preserving aliases, 1080p, and source aspect ratio", async () => {
    const models = [
      "grok-imagine-video-1.5",
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-1.5-2026-05-30",
    ];
    const provider = buildXaiVideoGenerationProvider();

    for (const [index, model] of models.entries()) {
      const requestId = `req_15_${index}`;
      postJsonRequestMock.mockResolvedValueOnce({
        response: { json: async () => ({ request_id: requestId }) },
        release: vi.fn(async () => {}),
      });
      fetchWithTimeoutMock
        .mockResolvedValueOnce({
          json: async () => ({
            request_id: requestId,
            status: "done",
            video: { url: `https://cdn.x.ai/${requestId}.mp4` },
          }),
        })
        .mockResolvedValueOnce({
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("video-bytes"),
        });

      const result = await provider.generateVideo({
        provider: "xai",
        model,
        prompt: "Animate this still image",
        cfg: {},
        durationSeconds: 20,
        resolution: index === 0 ? undefined : "1080P",
        inputImages: [
          {
            url: "https://example.com/first-frame.png",
            ...(index === 0 ? {} : { role: "first_frame" as const }),
          },
        ],
      });

      const body = requirePostJsonCall(index).body ?? {};
      expect(body.model).toBe(model);
      expect(body.image).toEqual({ url: "https://example.com/first-frame.png" });
      expect(body.duration).toBe(15);
      expect(body.resolution).toBe(index === 0 ? "480p" : "1080p");
      expect(body).not.toHaveProperty("aspect_ratio");
      expect(result.model).toBe(model);
    }
  });

  it("rejects unsupported 1.5 modes before submitting a request", async () => {
    const provider = buildXaiVideoGenerationProvider();
    const cases: Array<
      Pick<VideoGenerationRequest, "model" | "inputImages" | "inputVideos"> & { error: string }
    > = [
      {
        model: "grok-imagine-video-1.5",
        inputImages: undefined,
        error: "xAI grok-imagine-video-1.5 requires exactly one first-frame image.",
      },
      {
        model: "grok-imagine-video-1.5-preview",
        inputImages: [{ url: "https://example.com/reference.png", role: "reference_image" }],
        error: "xAI grok-imagine-video-1.5 supports only an ordinary or first_frame image.",
      },
      {
        model: "grok-imagine-video-1.5-2026-05-30",
        inputImages: [
          { url: "https://example.com/first.png" },
          { url: "https://example.com/second.png", role: "first_frame" },
        ],
        error: "xAI grok-imagine-video-1.5 requires exactly one first-frame image.",
      },
      {
        model: "grok-imagine-video-1.5",
        inputImages: undefined,
        inputVideos: [{ url: "https://example.com/input.mp4" }],
        error: "xAI grok-imagine-video-1.5 does not support video inputs.",
      },
    ];

    for (const testCase of cases) {
      await expect(
        provider.generateVideo({
          provider: "xai",
          model: testCase.model,
          prompt: "Unsupported 1.5 request",
          cfg: {},
          inputImages: testCase.inputImages,
          inputVideos: testCase.inputVideos,
        }),
      ).rejects.toThrow(testCase.error);
    }
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
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
    expect(provider.defaultTimeoutMs).toBe(600_000);
    expect(pollRequest.timeoutMs).toBeGreaterThan(599_000);
    expect(pollRequest.timeoutMs).toBeLessThanOrEqual(600_000);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.requestId).toBe("req_123");
    expect(result.metadata?.mode).toBe("generate");
  });

  it("applies configured xAI request policy to video generation requests", async () => {
    const dispatcherPolicy = { proxyUrl: "http://proxy.example:3128" };
    const requestPolicy = {
      headers: { "X-Xai-Trace": "trace-1" },
      proxy: { mode: "env-proxy" as const },
      allowPrivateNetwork: true,
    };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: true,
      headers: new Headers({
        ...params.defaultHeaders,
        "X-Xai-Trace": "trace-1",
      }),
      dispatcherPolicy: dispatcherPolicy as never,
    }));
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_policy",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_policy",
          status: "done",
          video: { url: "https://cdn.x.ai/policy.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("video-bytes"),
      });

    await buildXaiVideoGenerationProvider().generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Product demo shot",
      cfg: {
        models: {
          providers: {
            xai: {
              request: requestPolicy,
            },
          },
        },
      } as never,
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith(requestPolicy);
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        capability: "video",
        request: requestPolicy,
      }),
    );
    expect(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "allowPrivateNetwork",
    );
    const submitRequest = requirePostJsonCall();
    expect(submitRequest.allowPrivateNetwork).toBe(true);
    expect(submitRequest.dispatcherPolicy).toBe(dispatcherPolicy);
    expect(submitRequest.headers?.get("X-Xai-Trace")).toBe("trace-1");

    const pollCall = fetchWithTimeoutGuardedMock.mock.calls[0];
    expect(pollCall?.[0]).toBe("https://api.x.ai/v1/videos/req_policy");
    expect((pollCall?.[1] as { headers?: Headers } | undefined)?.headers?.get("X-Xai-Trace")).toBe(
      "trace-1",
    );
    expect(pollCall?.[4]).toMatchObject({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy,
      auditContext: "xai-video-status",
    });

    const downloadOptions = fetchWithTimeoutGuardedMock.mock.calls[1]?.[4] as
      | {
          ssrfPolicy?: { allowPrivateNetwork?: boolean };
          dispatcherPolicy?: unknown;
          auditContext?: string;
        }
      | undefined;
    expect(downloadOptions).toMatchObject({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy,
      auditContext: "xai-video-download",
    });
    const downloadInit = fetchWithTimeoutGuardedMock.mock.calls[1]?.[1] as
      | { headers?: Headers; method?: string }
      | undefined;
    expect(downloadInit?.method).toBe("GET");
    expect(downloadInit?.headers).toBeUndefined();
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ request_id: "req_too_large" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_too_large",
          status: "done",
          video: { url: "https://cdn.x.ai/too-large.mp4" },
        }),
      })
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("xAI generated video download exceeds 1 bytes");
  });

  it("bounds an unbounded successful xAI create JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue({
      response: oversized.response,
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "oversized create body",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation response: JSON response exceeds 16777216 bytes");
    // The bounded reader cancelled the stream rather than buffering the whole
    // body, and stopped reading well before the 64 MiB ceiling.
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("bounds an unbounded successful xAI poll JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ request_id: "req_poll_oversized" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(oversized.response);

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "oversized poll body",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation response: JSON response exceeds 16777216 bytes");
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("wraps malformed successful xAI create responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => [],
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "bad shape",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation response malformed");
  });

  it("wraps non-JSON successful xAI create responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response("<html>Unexpected token < in JSON</html>", {
        headers: { "content-type": "text/html" },
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "html body",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation response malformed");
  });

  it("treats unknown xAI poll statuses as continue-polling and returns when terminal", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ request_id: "req_unknown_then_done" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_unknown_then_done",
          status: "almost_done",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_unknown_then_done",
          status: "submitted",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_unknown_then_done",
          status: "done",
          video: { url: "https://cdn.x.ai/eventual.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "unknown then done",
      cfg: {},
    });

    expect(result.metadata?.requestId).toBe("req_unknown_then_done");
    expect(result.metadata?.status).toBe("done");
  });

  it("treats `cancelled` as a terminal failure", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ request_id: "req_cancelled" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        request_id: "req_cancelled",
        status: "cancelled",
      }),
    });

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "cancelled",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation cancelled");
  });

  it("rejects completed xAI poll responses without output URLs as malformed", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ request_id: "req_no_video" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        request_id: "req_no_video",
        status: "done",
        video: {},
      }),
    });

    const provider = buildXaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "xai",
        model: "grok-imagine-video",
        prompt: "missing video",
        cfg: {},
      }),
    ).rejects.toThrow("xAI video generation response malformed");
  });

  it("normalizes the xAI 'pending' poll status to 'processing' and keeps polling until done", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_pending",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      // First poll: in-progress payload mirroring xAI's real shape
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_pending",
          status: "pending",
          progress: 42,
        }),
      })
      // Second poll: complete
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_pending",
          status: "done",
          video: { url: "https://cdn.x.ai/video-pending.mp4" },
          progress: 100,
        }),
      })
      // Download
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Pending then done",
      cfg: {},
      durationSeconds: 6,
      aspectRatio: "9:16",
      resolution: "720P",
    });

    // Two poll calls (one pending, one done) — not throwing on "pending"
    expect((fetchWithTimeoutMock.mock.calls as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata?.requestId).toBe("req_pending");
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
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body.resolution).toBe("480p");
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
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "1080P",
      inputVideos: [{ url: "https://example.com/input.mp4" }],
    });

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://api.x.ai/v1/videos/extensions");
    expect(request.body?.video).toEqual({ url: "https://example.com/input.mp4" });
    expect(request.body?.duration).toBe(10);
    expect(request.body).not.toHaveProperty("aspect_ratio");
    expect(request.body).not.toHaveProperty("resolution");
  });
});
