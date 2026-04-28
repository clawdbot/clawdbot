import { expect, vi } from "vitest";
import type { VideoGenerationResult } from "../video-generation.js";

type ClearableMock = {
  mockClear(): unknown;
};

type ResettableMock = {
  mockReset(): unknown;
};

type ResolvableMock = {
  mockResolvedValue(value: unknown): unknown;
};

type ChainableResolvedValueMock = ResettableMock & {
  mockResolvedValueOnce(value: unknown): ChainableResolvedValueMock;
};

export type DashscopeVideoProviderMocks = {
  resolveApiKeyForProviderMock: ClearableMock;
  postJsonRequestMock: ResettableMock & ResolvableMock;
  fetchWithTimeoutMock: ChainableResolvedValueMock;
  assertOkOrThrowHttpErrorMock: ClearableMock;
  resolveProviderHttpRequestConfigMock: ClearableMock;
};

export function resetDashscopeVideoProviderMocks(mocks: DashscopeVideoProviderMocks): void {
  mocks.resolveApiKeyForProviderMock.mockClear();
  mocks.postJsonRequestMock.mockReset();
  mocks.fetchWithTimeoutMock.mockReset();
  mocks.assertOkOrThrowHttpErrorMock.mockClear();
  mocks.resolveProviderHttpRequestConfigMock.mockClear();
}

export function mockSuccessfulDashscopeVideoTask(
  mocks: Pick<DashscopeVideoProviderMocks, "postJsonRequestMock" | "fetchWithTimeoutMock">,
  params: {
    requestId?: string;
    taskId?: string;
    taskStatus?: string;
    videoUrl?: string;
  } = {},
): void {
  const {
    requestId = "req-1",
    taskId = "task-1",
    taskStatus = "SUCCEEDED",
    videoUrl = "https://example.com/out.mp4",
  } = params;
  mocks.postJsonRequestMock.mockResolvedValue({
    response: {
      json: async () => ({
        request_id: requestId,
        output: {
          task_id: taskId,
        },
      }),
    },
    release: vi.fn(async () => {}),
  });
  mocks.fetchWithTimeoutMock
    .mockResolvedValueOnce({
      json: async () => ({
        output: {
          task_status: taskStatus,
          results: [{ video_url: videoUrl }],
        },
      }),
      headers: new Headers(),
    })
    .mockResolvedValueOnce({
      arrayBuffer: async () => Buffer.from("mp4-bytes"),
      headers: new Headers({ "content-type": "video/mp4" }),
    });
}

export function expectDashscopeVideoTaskPoll(
  fetchWithTimeoutMock: ChainableResolvedValueMock,
  params: {
    baseUrl?: string;
    taskId?: string;
    timeoutMs?: number;
  } = {},
): void {
  const {
    baseUrl = "https://dashscope-intl.aliyuncs.com",
    taskId = "task-1",
    timeoutMs = 120_000,
  } = params;
  expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
    1,
    `${baseUrl}/api/v1/tasks/${taskId}`,
    expect.objectContaining({ method: "GET" }),
    timeoutMs,
    fetch,
  );
}

export function expectSuccessfulDashscopeVideoResult(
  result: VideoGenerationResult,
  params: {
    requestId?: string;
    taskId?: string;
    taskStatus?: string;
  } = {},
): void {
  const { requestId = "req-1", taskId = "task-1", taskStatus = "SUCCEEDED" } = params;
  expect(result.videos).toHaveLength(1);
  expect(result.videos[0]?.mimeType).toBe("video/mp4");
  expect(result.metadata).toEqual(
    expect.objectContaining({
      requestId,
      taskId,
      taskStatus,
    }),
  );
}
