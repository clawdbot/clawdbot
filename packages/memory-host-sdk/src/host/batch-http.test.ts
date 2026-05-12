import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./post-json.js", () => ({
  postJson: vi.fn(),
}));

type RetryOptions = {
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (err: unknown) => boolean;
};

type PostJsonParams = {
  url?: unknown;
  headers?: unknown;
  body?: unknown;
  errorPrefix?: unknown;
  attachStatus?: unknown;
};

function requirePostJsonParams(
  postJsonMock: ReturnType<typeof vi.mocked<typeof import("./post-json.js").postJson>>,
): PostJsonParams {
  const [call] = postJsonMock.mock.calls;
  if (!call) {
    throw new Error("expected postJson call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected postJson params to be an object");
  }
  return params;
}

function requireRetryOptions(call: unknown[] | undefined): RetryOptions {
  const options = call?.[1] as RetryOptions | undefined;
  if (!options) {
    throw new Error("expected retry options");
  }
  return options;
}

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
    const postJsonParams = requirePostJsonParams(postJsonMock);
    expect(postJsonParams.url).toBe("https://memory.example/v1/batch");
    expect(postJsonParams.headers).toEqual({ Authorization: "Bearer test" });
    expect(postJsonParams.body).toEqual({ chunks: ["a", "b"] });
    expect(postJsonParams.errorPrefix).toBe("memory batch failed");
    expect(postJsonParams.attachStatus).toBe(true);

    const retryOptions = requireRetryOptions(retryAsyncMock.mock.calls.at(0));
    expect(retryOptions.attempts).toBe(3);
    expect(retryOptions.minDelayMs).toBe(300);
    expect(retryOptions.maxDelayMs).toBe(2000);
    expect(retryOptions.shouldRetry({ status: 429 })).toBe(true);
    expect(retryOptions.shouldRetry({ status: 503 })).toBe(true);
    expect(retryOptions.shouldRetry({ status: 400 })).toBe(false);
  });

  it("attaches status to non-ok errors", async () => {
    postJsonMock.mockRejectedValueOnce(
      Object.assign(new Error("memory batch failed: 503 backend down"), { status: 503 }),
    );

    let error: unknown;
    try {
      await postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: [] },
        errorPrefix: "memory batch failed",
        retryImpl: retryAsyncMock as typeof import("./retry-utils.js").retryAsync,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("memory batch failed: 503 backend down");
    expect((error as { status?: unknown }).status).toBe(503);
  });
});
