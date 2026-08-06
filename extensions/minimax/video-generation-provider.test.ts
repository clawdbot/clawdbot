// Minimax tests cover video generation provider plugin behavior.
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  executeProviderOperationWithRetryMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
  resolveProviderHttpRequestConfigMock,
} = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];
let buildMinimaxPortalVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxPortalVideoGenerationProvider"];

beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider, buildMinimaxPortalVideoGenerationProvider } =
    await loadMinimaxVideoGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

function expectMinimaxFetchCall(index: number, url: string) {
  const call = fetchWithTimeoutMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected MiniMax fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn] = call;
  expect(actualUrl).toBe(url);
  expect(init?.method).toBe("GET");
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
}

function expectMinimaxGuardedFetchCall(index: number, url: string) {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected MiniMax guarded fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn, options] = call;
  expect(actualUrl).toBe(url);
  expect((init as RequestInit | undefined)?.method).toBe("GET");
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
  return {
    init: init as RequestInit,
    options: options as Record<string, unknown> | undefined,
  };
}

function expectAllowPrivateNetworkPolicy(options: Record<string, unknown> | undefined): void {
  expect(options).toEqual({
    ssrfPolicy: { allowPrivateNetwork: true },
  });
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function oversizedJsonResponse(): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
      cancel: vi.fn(),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("minimax video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    const provider = buildMinimaxVideoGenerationProvider();
    expectExplicitVideoGenerationCapabilities(provider);
    expect(provider.capabilities.generate?.resolutions).toEqual(["768P", "1080P"]);
    expect(provider.capabilities.imageToVideo?.resolutions).toEqual(["768P", "1080P"]);
  });

  it("creates a task, polls status, and downloads the generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        task_id: "task-123",
        base_resp: { status_code: 0 },
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-123",
          status: "Success",
          video_url: "https://example.com/out.mp4",
          file_id: "file-1",
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      cfg: {},
      durationSeconds: 5,
      resolution: "720P",
    });

    const request = mockCallArg(postJsonRequestMock);
    expect(request.url).toBe("https://api.minimax.io/v1/video_generation");
    const body = request.body as Record<string, unknown>;
    expect(body.duration).toBe(6);
    expect(body.resolution).toBe("768P");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.taskId).toBe("task-123");
    expect(result.metadata?.fileId).toBe("file-1");
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        task_id: "task-too-large",
        base_resp: { status_code: 0 },
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-too-large",
          status: "Success",
          video_url: "https://example.com/too-large.mp4",
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildMinimaxVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "minimax",
        model: "MiniMax-Hailuo-2.3",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("MiniMax generated video download exceeds 1 bytes");
  });

  it("downloads via file_id when the status response omits video_url", async () => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-MiniMax-Video-Policy": "enabled" },
    };
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        task_id: "task-456",
        base_resp: { status_code: 0 },
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-456",
          status: "Success",
          file_id: "file-9",
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          file: {
            file_id: "file-9",
            filename: "output_aigc.mp4",
            download_url: "https://example.com/download.mp4",
          },
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io",
              models: [],
              request: requestOverrides,
            },
          },
        },
      },
    });

    expectMinimaxFetchCall(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
    expectMinimaxFetchCall(2, "https://example.com/download.mp4");
    const statusFetch = expectMinimaxGuardedFetchCall(
      0,
      "https://api.minimax.io/v1/query/video_generation?task_id=task-456",
    );
    expect((statusFetch.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expectAllowPrivateNetworkPolicy(statusFetch.options);
    const metadataFetch = expectMinimaxGuardedFetchCall(
      1,
      "https://api.minimax.io/v1/files/retrieve?file_id=file-9",
    );
    expect((metadataFetch.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expectAllowPrivateNetworkPolicy(metadataFetch.options);
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(2, "https://example.com/download.mp4").options,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata?.taskId).toBe("task-456");
    expect(result.metadata?.fileId).toBe("file-9");
    expect(result.metadata?.videoUrl).toBeUndefined();
  });

  it("retries guarded video status polling while preserving request policy", async () => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-MiniMax-Video-Policy": "enabled" },
    };
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        task_id: "task-retry",
        base_resp: { status_code: 0 },
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockRejectedValueOnce(new Error("temporary poll failure"))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-retry",
          status: "Success",
          video_url: "https://example.com/retry.mp4",
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io",
              models: [],
              request: requestOverrides,
            },
          },
        },
      },
    });

    const firstPoll = expectMinimaxGuardedFetchCall(
      0,
      "https://api.minimax.io/v1/query/video_generation?task_id=task-retry",
    );
    expect((firstPoll.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expectAllowPrivateNetworkPolicy(firstPoll.options);
    const secondPoll = expectMinimaxGuardedFetchCall(
      1,
      "https://api.minimax.io/v1/query/video_generation?task_id=task-retry",
    );
    expect((secondPoll.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expectAllowPrivateNetworkPolicy(secondPoll.options);
    expect(result.videos).toHaveLength(1);
    expect(
      executeProviderOperationWithRetryMock.mock.calls.map(
        ([params]) => (params as { stage: string }).stage,
      ),
    ).toContain("poll");
  });

  it("rejects oversized file_id metadata JSON before downloading", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          task_id: "task-metadata-too-large",
          base_resp: { status_code: 0 },
        }),
      ),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task_id: "task-metadata-too-large",
            status: "Success",
            file_id: "file-too-large",
            base_resp: { status_code: 0 },
          }),
        ),
      )
      .mockResolvedValueOnce(oversizedJsonResponse());

    const provider = buildMinimaxVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "minimax",
        model: "MiniMax-Hailuo-2.3",
        prompt: "A fox sprints across snowy hills",
        cfg: {},
      }),
    ).rejects.toThrow("MiniMax generated video metadata: JSON response exceeds 16777216 bytes");

    expectMinimaxFetchCall(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-too-large");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("routes portal video generation through minimax-portal auth and HTTP config", async () => {
    const requestOverrides = {
      allowPrivateNetwork: true,
      headers: { "X-MiniMax-Video-Policy": "enabled" },
    };
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        task_id: "task-portal",
        base_resp: { status_code: 0 },
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-portal",
          status: "Success",
          video_url: "https://example.com/portal.mp4",
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildMinimaxPortalVideoGenerationProvider();
    await provider.generateVideo({
      provider: "minimax-portal",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A neon city street at night",
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://wrong.example/anthropic",
              models: [],
            },
            "minimax-portal": {
              baseUrl: "https://api.minimaxi.com/anthropic",
              models: [],
              request: requestOverrides,
            },
          },
        },
      },
    });

    expect(mockCallArg(resolveApiKeyForProviderMock).provider).toBe("minimax-portal");
    const httpConfigParams = mockCallArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigParams.baseUrl).toBe("https://api.minimaxi.com");
    expect(httpConfigParams.provider).toBe("minimax-portal");
    expect(httpConfigParams.capability).toBe("video");
    expect(httpConfigParams.transport).toBe("http");
    expect(httpConfigParams.request).toEqual(requestOverrides);
    const postParams = mockCallArg(postJsonRequestMock);
    expect(postParams.allowPrivateNetwork).toBe(true);
    expect((postParams.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expect(postParams.url).toBe("https://api.minimaxi.com/v1/video_generation");
    const statusFetch = expectMinimaxGuardedFetchCall(
      0,
      "https://api.minimaxi.com/v1/query/video_generation?task_id=task-portal",
    );
    expect((statusFetch.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    expectAllowPrivateNetworkPolicy(statusFetch.options);
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(1, "https://example.com/portal.mp4").options,
    );
  });
});
