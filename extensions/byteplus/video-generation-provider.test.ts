// Byteplus tests cover video generation provider plugin behavior.
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Submit/poll transport is mocked locally so each test can inject the BytePlus task JSON
// bodies, while readProviderJsonResponse is kept REAL (via importActual) so the byte-bounded
// reader actually streams and cancels oversized bodies under test instead of a stub.
const {
  postJsonRequestMock,
  fetchWithTimeoutMock,
  guardedDownloadParamsMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  guardedDownloadParamsMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    // REAL byte-bounded JSON reader under test — not stubbed.
    readProviderJsonResponse: actual.readProviderJsonResponse,
    postJsonRequest: postJsonRequestMock,
    pollProviderOperationJson: async (params: {
      url: string;
      headers: Headers;
      defaultTimeoutMs: number;
      maxAttempts: number;
      requestFailedMessage: string;
      timeoutMessage: string;
      isComplete: (payload: unknown) => boolean;
      getFailureMessage?: (payload: unknown) => string | undefined;
    }) => {
      for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
        const response = await fetchWithTimeoutMock(
          params.url,
          { method: "GET", headers: params.headers },
          params.defaultTimeoutMs,
        );
        const payload = await actual.readProviderJsonResponse(
          response,
          params.requestFailedMessage,
        );
        if (params.isComplete(payload)) {
          return payload;
        }
        const failureMessage = params.getFailureMessage?.(payload);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
      }
      throw new Error(params.timeoutMessage);
    },
    fetchGuardedProviderDownloadResponse: async (params: {
      url: string;
      init?: RequestInit;
      deadline: { deadlineAtMs?: number; timeoutMs?: number };
      fetchFn: typeof fetch;
      allowPrivateNetwork?: boolean;
      dispatcherPolicy?: unknown;
    }) => {
      guardedDownloadParamsMock(params);
      const response = await fetchWithTimeoutMock(
        params.url,
        params.init ?? {},
        params.deadline.deadlineAtMs === undefined
          ? (params.deadline.timeoutMs ?? 60_000)
          : Math.max(1, params.deadline.deadlineAtMs - Date.now()),
      );
      return { response, release: async () => {} };
    },
    assertOkOrThrowHttpError: async () => {},
    createProviderOperationDeadline: ({
      label,
      timeoutMs,
    }: {
      label: string;
      timeoutMs?: number | (() => number);
    }) => {
      const resolvedTimeoutMs = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
      return {
        label,
        timeoutMs: resolvedTimeoutMs,
        deadlineAtMs:
          typeof resolvedTimeoutMs === "number" ? Date.now() + resolvedTimeoutMs : undefined,
      };
    },
    createProviderOperationTimeoutResolver:
      ({
        deadline,
        defaultTimeoutMs,
      }: {
        deadline: { deadlineAtMs?: number; label: string; timeoutMs?: number };
        defaultTimeoutMs: number;
      }) =>
      () => {
        if (typeof deadline.deadlineAtMs !== "number") {
          return defaultTimeoutMs;
        }
        const remainingMs = deadline.deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`${deadline.label} timed out after ${deadline.timeoutMs}ms`);
        }
        return Math.min(defaultTimeoutMs, remainingMs);
      },
    resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
      defaultTimeoutMs,
    sanitizeConfiguredModelProviderRequest: (request: unknown) => request,
    resolveProviderHttpRequestConfig: (params: {
      baseUrl?: string;
      defaultBaseUrl: string;
      allowPrivateNetwork?: boolean;
      defaultHeaders?: Record<string, string>;
      request?: { allowPrivateNetwork?: boolean };
    }) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork:
        (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
      headers: new Headers(params.defaultHeaders),
      dispatcherPolicy: undefined,
    }),
  };
});

let buildBytePlusVideoGenerationProvider: typeof import("./video-generation-provider.js").buildBytePlusVideoGenerationProvider;

beforeAll(async () => {
  ({ buildBytePlusVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

afterEach(() => {
  postJsonRequestMock.mockReset();
  fetchWithTimeoutMock.mockReset();
  guardedDownloadParamsMock.mockReset();
  resolveApiKeyForProviderMock.mockClear();
  vi.useRealTimers();
});

function mockSuccessfulBytePlusTask(params?: { model?: string }) {
  postJsonRequestMock.mockResolvedValue({
    response: streamedJsonResponse({
      id: "task_123",
    }),
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_123",
        status: "succeeded",
        content: {
          video_url: "https://example.com/byteplus.mp4",
        },
        model: params?.model ?? "seedance-1-0-pro-250528",
      }),
    )
    .mockResolvedValueOnce({
      headers: new Headers({ "content-type": "video/webm" }),
      arrayBuffer: async () => Buffer.from("webm-bytes"),
    });
}

function requireBytePlusPostRequest(): { body?: Record<string, unknown>; url?: string } {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected BytePlus video request");
  }
  const [request] = call;
  if (!request) {
    throw new Error("expected BytePlus video request");
  }
  if (typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected BytePlus video request options");
  }
  return request as { body?: Record<string, unknown>; url?: string };
}

function requireBytePlusPostBody(): Record<string, unknown> {
  const request = requireBytePlusPostRequest();
  if (!request.body) {
    throw new Error("expected BytePlus video request body");
  }
  return request.body;
}

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

// BytePlus submit/poll task JSON is now read through the byte-bounded reader, so the
// mocked responses must expose a real readable body (not just a json() shortcut).
function streamedJsonResponse(payload: unknown): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Builds a JSON body larger than the shared 16 MiB readProviderJsonResponse cap so the
// bounded reader cancels the stream mid-flight; if the cap were removed the reader would
// buffer the whole advertised payload before parsing. Tracks how many bytes were pulled
// and whether the stream was canceled so callers can assert the body was not fully read.
function makeOversizedJsonStream(): {
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  totalBytes: number;
  state: { bytesPulled: number; canceled: boolean };
} {
  const maxBytes = 16 * 1024 * 1024; // matches PROVIDER_JSON_RESPONSE_MAX_BYTES.
  const ONE_MIB = 1024 * 1024;
  const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
  const chunk = new Uint8Array(ONE_MIB);
  const state = { bytesPulled: 0, canceled: false };
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= TOTAL_CHUNKS) {
        controller.close();
        return;
      }
      pulled += 1;
      state.bytesPulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.canceled = true;
    },
  });
  return { body, maxBytes, totalBytes: TOTAL_CHUNKS * ONE_MIB, state };
}

describe("byteplus video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    const provider = buildBytePlusVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.defaultModel).toBe("seedance-1-0-pro-250528");
    expect(provider.models).toEqual(["seedance-1-0-pro-250528", "seedance-1-5-pro-251215"]);
  });

  it("creates a content-generation task, polls, and downloads the video", async () => {
    mockSuccessfulBytePlusTask();

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const request = requireBytePlusPostRequest();
    expect(request.url).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
    );
    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated BytePlus video");
    }
    expect(video.fileName).toBe("video-1.webm");
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.taskId).toBe("task_123");
  });

  it("routes the generated video download through the SSRF-guarded fetch", async () => {
    mockSuccessfulBytePlusTask();

    await buildBytePlusVideoGenerationProvider().generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(guardedDownloadParamsMock).toHaveBeenCalledTimes(1);
    const params = guardedDownloadParamsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ provider: "byteplus", allowPrivateNetwork: false });
    expect(params).toHaveProperty("dispatcherPolicy");
  });

  it("threads the configured allowPrivateNetwork opt-in into the guarded download", async () => {
    mockSuccessfulBytePlusTask();

    await buildBytePlusVideoGenerationProvider().generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A lantern floats upward into the night sky",
      cfg: {
        models: {
          providers: {
            byteplus: {
              baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
              models: [],
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    });

    expect(guardedDownloadParamsMock).toHaveBeenCalledTimes(1);
    const params = guardedDownloadParamsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ provider: "byteplus", allowPrivateNetwork: true });
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_too_large" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_too_large",
          status: "succeeded",
          content: {
            video_url: "https://example.com/too-large.mp4",
          },
        }),
      )
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("BytePlus generated video download exceeds 1 bytes");
  });

  it("shares one wall-clock deadline across download headers and body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_slow_download" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_slow_download",
          status: "succeeded",
          content: { video_url: "https://example.com/slow.mp4" },
        }),
      )
      .mockImplementationOnce(async () => {
        vi.setSystemTime(1_090);
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(new Uint8Array([1]));
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
              });
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        );
      });

    const result = buildBytePlusVideoGenerationProvider().generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "slow download",
      timeoutMs: 100,
      cfg: {},
    });
    const assertion = expect(result).rejects.toThrow(
      "BytePlus generated video download timed out after 100ms",
    );

    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it("keeps the unified model for image requests and lowercases resolution", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "Animate this still image",
      resolution: "720P",
      inputImages: [{ url: "https://example.com/first-frame.png" }],
      cfg: {},
    });

    expect(requireBytePlusPostBody()).toEqual({
      model: "seedance-1-0-pro-250528",
      resolution: "720p",
      content: [
        { type: "text", text: "Animate this still image" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first-frame.png" },
          role: "first_frame",
        },
      ],
    });
  });

  it("maps declared providerOptions into the request body", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      providerOptions: {
        seed: 42,
        draft: true,
        camera_fixed: false,
      },
      cfg: {},
    });

    const body = requireBytePlusPostBody();
    expect(body.model).toBe("seedance-1-0-pro-250528");
    expect(body.seed).toBe(42);
    expect(body.resolution).toBe("480p");
    expect(body.camera_fixed).toBe(false);
  });

  it("drops malformed seed values before creating videos", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      providerOptions: {
        seed: 1.5,
      },
      cfg: {},
    });

    expect(requireBytePlusPostBody()).not.toHaveProperty("seed");
  });

  it("drops out-of-range duration values before creating videos", async () => {
    mockSuccessfulBytePlusTask({ model: "seedance-1-0-pro-250528" });

    const provider = buildBytePlusVideoGenerationProvider();
    await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A cinematic lobster montage",
      durationSeconds: 99,
      cfg: {},
    });

    expect(requireBytePlusPostBody()).not.toHaveProperty("duration");
  });

  it("drops malformed response duration metadata", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "task_123",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_123",
          status: "succeeded",
          content: {
            video_url: "https://example.com/byteplus.mp4",
          },
          duration: 1.5,
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildBytePlusVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "A lantern floats upward into the night sky",
      cfg: {},
    });

    expect(result.metadata).toMatchObject({ duration: undefined });
  });

  it("reports malformed create JSON with a provider-owned error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{ not valid json"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release,
    });

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "bad create response",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects status responses missing a task status", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_missing_status" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_missing_status",
        content: {
          video_url: "https://example.com/byteplus.mp4",
        },
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "missing status",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video status response missing task status");
  });

  it("rejects malformed completed content", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_malformed_content" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_malformed_content",
        status: "succeeded",
        content: ["https://example.com/byteplus.mp4"],
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "malformed content",
        cfg: {},
      }),
    ).rejects.toThrow("BytePlus video generation completed with malformed content");
  });

  it("bounds the submit task JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "oversized submit response",
        cfg: {},
      }),
    ).rejects.toThrow(
      `BytePlus video generation failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    // Only the bounded prefix is pulled, never the full advertised stream.
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
    // The submit request must still be released even though the body overflowed.
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds the poll status JSON body and cancels an oversized stream", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task_oversized_poll" }),
      release: vi.fn(async () => {}),
    });
    const stream = makeOversizedJsonStream();
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = buildBytePlusVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "byteplus",
        model: "seedance-1-0-pro-250528",
        prompt: "oversized poll response",
        cfg: {},
      }),
    ).rejects.toThrow(
      `BytePlus video status request failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
  });
});
