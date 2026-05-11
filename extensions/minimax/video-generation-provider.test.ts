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
  fetchWithTimeoutMock,
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

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
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
      response: {
        json: async () => ({
          task_id: "task-123",
          base_resp: { status_code: 0 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          task_id: "task-123",
          status: "Success",
          video_url: "https://example.com/out.mp4",
          file_id: "file-1",
          base_resp: { status_code: 0 },
        }),
      })
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

  it("downloads via file_id when the status response omits video_url", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          task_id: "task-456",
          base_resp: { status_code: 0 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          task_id: "task-456",
          status: "Success",
          file_id: "file-9",
          base_resp: { status_code: 0 },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          file: {
            file_id: "file-9",
            filename: "output_aigc.mp4",
            download_url: "https://example.com/download.mp4",
          },
          base_resp: { status_code: 0 },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      cfg: {},
    });

    expectMinimaxFetchCall(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
    expectMinimaxFetchCall(2, "https://example.com/download.mp4");
    expect(result.videos).toHaveLength(1);
    expect(result.metadata?.taskId).toBe("task-456");
    expect(result.metadata?.fileId).toBe("file-9");
    expect(result.metadata?.videoUrl).toBeUndefined();
  });

  it("routes portal video generation through minimax-portal auth and HTTP config", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          task_id: "task-portal",
          base_resp: { status_code: 0 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          task_id: "task-portal",
          status: "Success",
          video_url: "https://example.com/portal.mp4",
          base_resp: { status_code: 0 },
        }),
      })
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
    expect(mockCallArg(postJsonRequestMock).url).toBe(
      "https://api.minimaxi.com/v1/video_generation",
    );
    expectMinimaxFetchCall(
      0,
      "https://api.minimaxi.com/v1/query/video_generation?task_id=task-portal",
    );
  });
});
