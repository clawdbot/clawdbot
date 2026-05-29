import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import {
  expectDashscopeVideoTaskPoll,
  expectExplicitVideoGenerationCapabilities,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildQwenVideoGenerationProvider: typeof import("./video-generation-provider.js").buildQwenVideoGenerationProvider;

beforeAll(async () => {
  ({ buildQwenVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function expectPostJsonRequest(
  call: unknown,
  expected: {
    url: string;
    body: Record<string, unknown>;
  },
) {
  if (!call || typeof call !== "object") {
    throw new Error("expected postJsonRequest call object");
  }
  const request = call as {
    url?: unknown;
    headers?: unknown;
    body?: unknown;
    timeoutMs?: unknown;
    fetchFn?: unknown;
    allowPrivateNetwork?: unknown;
    dispatcherPolicy?: unknown;
  };
  expect(request.url).toBe(expected.url);
  expect(request.body).toEqual(expected.body);
  expect(request.timeoutMs).toBe(120_000);
  expect(request.fetchFn).toBe(globalThis.fetch);
  expect(request.allowPrivateNetwork).toBe(false);
  expect(request.dispatcherPolicy).toBeUndefined();
  expect(request.headers).toBeInstanceOf(Headers);
  expect(Array.from((request.headers as Headers).entries())).toEqual([
    ["authorization", "Bearer provider-key"],
    ["content-type", "application/json"],
    ["x-dashscope-async", "enable"],
  ]);
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

describe("qwen video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildQwenVideoGenerationProvider());
  });

  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const provider = buildQwenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "qwen",
      model: "wan2.6-r2v-flash",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
      durationSeconds: 6,
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expectPostJsonRequest(postJsonRequestMock.mock.calls[0]?.[0], {
      url: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      body: {
        model: "wan2.6-r2v-flash",
        input: {
          prompt: "animate this shot",
          img_url: "https://example.com/ref.png",
        },
        parameters: {
          duration: 6,
          enable_audio: true,
        },
      },
    });
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });

  it("rejects DashScope video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req-too-large",
          output: { task_id: "task-too-large" },
        }),
      },
      release: async () => {},
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          output: {
            task_status: "SUCCEEDED",
            results: [{ video_url: "https://example.com/too-large.mp4" }],
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildQwenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "qwen",
        model: "wan2.6-r2v-flash",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Qwen generated video download exceeds 1 bytes");
  });

  it("fails fast when reference inputs are local buffers instead of remote URLs", async () => {
    const provider = buildQwenVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "qwen",
        model: "wan2.6-i2v",
        prompt: "animate this local frame",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(
      "Qwen video generation currently requires remote http(s) URLs for reference images/videos.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("preserves dedicated coding endpoints for dedicated API keys", async () => {
    mockSuccessfulDashscopeVideoTask(
      {
        postJsonRequestMock,
        fetchWithTimeoutMock,
      },
      { requestId: "req-2", taskId: "task-2" },
    );

    const provider = buildQwenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "qwen",
      model: "wan2.6-t2v",
      prompt: "animate this shot",
      cfg: {
        models: {
          providers: {
            qwen: {
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expectPostJsonRequest(postJsonRequestMock.mock.calls[0]?.[0], {
      url: "https://coding-intl.dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      body: {
        model: "wan2.6-t2v",
        input: {
          prompt: "animate this shot",
        },
        parameters: {
          duration: 5,
        },
      },
    });
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock, {
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com",
      taskId: "task-2",
    });
  });
});
