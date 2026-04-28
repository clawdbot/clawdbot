import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./post-json.js", () => ({
  postJson: vi.fn(),
}));

describe("postJsonWithRetry", () => {
  let postJsonMock: ReturnType<typeof vi.mocked<typeof import("./post-json.js").postJson>>;
  let postJsonWithRetry: typeof import("./batch-http.js").postJsonWithRetry;
  let retryAsyncMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    ({ postJsonWithRetry } = await import("./batch-http.js"));
    const postJsonModule = await import("./post-json.js");
    postJsonMock = vi.mocked(postJsonModule.postJson);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    retryAsyncMock = vi.fn(async (run: () => Promise<unknown>) => await run());
  });

  it("posts JSON and returns parsed response payload", async () => {
    postJsonMock.mockImplementationOnce(async (params) => {
      return await params.parse({ ok: true, ids: [1, 2] });
    });

    const result = await postJsonWithRetry<{ ok: boolean; ids: number[] }>({
      url: "https://memory.example/v1/batch",
      headers: { Authorization: "Bearer test" },
      body: { chunks: ["a", "b"] },
      errorPrefix: "memory batch failed",
      retryImpl: retryAsyncMock as typeof import("./retry-utils.js").retryAsync,
    });

    expect(result).toEqual({ ok: true, ids: [1, 2] });
    expect(postJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://memory.example/v1/batch",
        headers: { Authorization: "Bearer test" },
        body: { chunks: ["a", "b"] },
        errorPrefix: "memory batch failed",
        attachStatus: true,
      }),
    );

    const retryOptions = retryAsyncMock.mock.calls[0]?.[1] as
      | {
          attempts: number;
          minDelayMs: number;
          maxDelayMs: number;
          shouldRetry: (err: unknown) => boolean;
        }
      | undefined;
    expect(retryOptions?.attempts).toBe(3);
    expect(retryOptions?.minDelayMs).toBe(300);
    expect(retryOptions?.maxDelayMs).toBe(2000);
    expect(retryOptions?.shouldRetry({ status: 429 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 503 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 400 })).toBe(false);
  });

  it("attaches status to non-ok errors", async () => {
    postJsonMock.mockRejectedValueOnce(
      Object.assign(new Error("memory batch failed: 503 backend down"), { status: 503 }),
    );

    await expect(
      postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: [] },
        errorPrefix: "memory batch failed",
        retryImpl: retryAsyncMock as typeof import("./retry-utils.js").retryAsync,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("memory batch failed: 503 backend down"),
      status: 503,
    });
  });
});
