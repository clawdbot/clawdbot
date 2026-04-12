import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
} from "./provider-http.test-helpers.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];

beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider } = await loadMinimaxVideoGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

describe("minimax video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildMinimaxVideoGenerationProvider());
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
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildMinimaxVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      prompt: "A fox sprints across snowy hills",
      cfg: {},
      durationSeconds: 5,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.minimax.io/v1/video_generation",
        body: expect.objectContaining({
          duration: 6,
        }),
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task-123",
        fileId: "file-1",
      }),
    );
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

    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      "https://api.minimax.io/v1/files/retrieve?file_id=file-9",
      expect.objectContaining({
        method: "GET",
      }),
      expect.any(Number),
      expect.any(Function),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      3,
      "https://example.com/download.mp4",
      expect.objectContaining({
        method: "GET",
      }),
      expect.any(Number),
      expect.any(Function),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task-456",
        fileId: "file-9",
        videoUrl: undefined,
      }),
    );
  });
});
