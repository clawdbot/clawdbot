// Mattermost tests cover client.retry plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  resolveMattermostReplyDeliveryBarrierTimeoutMs,
} from "./client.js";

describe("resolveMattermostReplyDeliveryBarrierTimeoutMs", () => {
  it("uses the default barrier for non-DM deliveries", () => {
    expect(
      resolveMattermostReplyDeliveryBarrierTimeoutMs({
        isDirect: false,
        queuedCounts: { tool: 1, block: 1, final: 1 },
      }),
    ).toBeUndefined();
  });

  it("uses the default barrier when no deliveries were queued", () => {
    expect(
      resolveMattermostReplyDeliveryBarrierTimeoutMs({
        isDirect: true,
        queuedCounts: { tool: 0, block: 0, final: 0 },
      }),
    ).toBeUndefined();
  });

  it("covers the default retry envelope plus scheduling slack", () => {
    expect(
      resolveMattermostReplyDeliveryBarrierTimeoutMs({
        isDirect: true,
        queuedCounts: { tool: 0, block: 0, final: 1 },
      }),
    ).toBe(210_000);
  });

  it("covers one maximum retry envelope per queued delivery", () => {
    expect(
      resolveMattermostReplyDeliveryBarrierTimeoutMs({
        isDirect: true,
        dmRetryOptions: {
          maxRetries: 10,
          maxDelayMs: 60_000,
          timeoutMs: 120_000,
        },
        queuedCounts: { tool: 1, block: 0, final: 1 },
      }),
    ).toBe(3_960_000);
  });

  it("includes the configured inter-block delay budget", () => {
    expect(
      resolveMattermostReplyDeliveryBarrierTimeoutMs({
        isDirect: true,
        queuedCounts: { tool: 0, block: 2, final: 0 },
        humanDelayBudgetMs: 180_000,
      }),
    ).toBe(600_000);
  });
});

describe("createMattermostDirectChannelWithRetry", () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMockClient() {
    return createMattermostClient({
      baseUrl: "https://mattermost.example.com",
      botToken: "test-token",
      fetchImpl: mockFetch,
    });
  }

  function createFetchFailedError(params: { message: string; code?: string }): TypeError {
    const cause = Object.assign(new Error(params.message), {
      code: params.code,
    });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  async function resolveRetryRun<T>(run: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return await run;
  }

  function suppressUnhandled<T>(run: Promise<T>): Promise<T> {
    run.catch(() => {});
    return run;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return Response.json(body, { status });
  }

  it("succeeds on first attempt without retries", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "dm-channel-123" }, 201));

    const client = createMockClient();
    const onRetry = vi.fn();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        onRetry,
      }),
    );

    expect(result.id).toBe("dm-channel-123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries on 429 rate limit error and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Too many requests" }, 429))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-456" }, 201));

    const client = createMockClient();
    const onRetry = vi.fn();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
        onRetry,
      }),
    );

    expect(result.id).toBe("dm-channel-456");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const retryCall = onRetry.mock.calls[0];
    expect(retryCall?.[0]).toBe(1);
    expect(retryCall?.[1]).toBeGreaterThanOrEqual(10);
    expect(retryCall?.[1]).toBeLessThanOrEqual(20);
    expect(retryCall?.[2]).toBeInstanceOf(Error);
    expect((retryCall?.[2] as Error | undefined)?.message).toContain("Too many requests");
  });

  it("retries on port 443 connection errors (not misclassified as 4xx)", async () => {
    // This tests that port numbers like :443 don't trigger false 4xx classification
    mockFetch
      .mockRejectedValueOnce(new Error("connect ECONNRESET 104.18.32.10:443"))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-port" }, 201));

    const client = createMockClient();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );

    // Should retry and succeed on second attempt (port 443 should NOT be treated as 4xx)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.id).toBe("dm-channel-port");
  });

  it("does not retry on 400 even if error message contains '429' text", async () => {
    // This tests that "429" in error detail doesn't trigger false rate-limit retry
    // e.g., "Invalid user ID: 4294967295" should NOT be retried
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Invalid user ID: 4294967295" }, 400));

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("Mattermost API 400");

    // Should not retry - only called once (400 is a client error, even though message contains "429")
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx server errors", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Service unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-789" }, 201));

    const client = createMockClient();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );

    expect(result.id).toBe("dm-channel-789");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Network error: connection refused"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-abc" }, 201));

    const client = createMockClient();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );

    expect(result.id).toBe("dm-channel-abc");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on fetch failed errors when the cause carries a transient code", async () => {
    mockFetch
      .mockRejectedValueOnce(
        createFetchFailedError({
          message: "connect ECONNREFUSED 127.0.0.1:81",
          code: "ECONNREFUSED",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-fetch-failed" }, 201));

    const client = createMockClient();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );

    expect(result.id).toBe("dm-channel-fetch-failed");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx client errors (except 429)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Bad request" }, 400));

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("400");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404 not found", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "User not found" }, 404));

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("404");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all retries", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ message: "Service unavailable" }, 503));

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 2,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("Mattermost API 503");

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects custom timeout option and aborts fetch", async () => {
    let abortSignal: AbortSignal | undefined;
    let abortListenerCalled = false;

    mockFetch.mockImplementationOnce((url, init) => {
      abortSignal = init?.signal ?? undefined;
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          abortListenerCalled = true;
        });
      }
      // Return a promise that rejects when aborted, otherwise never resolves
      return new Promise((_, reject) => {
        if (abortSignal) {
          const checkAbort = () => {
            if (abortSignal?.aborted) {
              reject(new Error("AbortError"));
            } else {
              setTimeout(checkAbort, 10);
            }
          };
          setTimeout(checkAbort, 10);
        }
      });
    });

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        timeoutMs: 50,
        maxRetries: 0,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("AbortError");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(abortSignal?.aborted).toBe(true);
    expect(abortListenerCalled).toBe(true);
  });

  it("caps oversized request timeouts before scheduling aborts", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "dm-channel-capped" }, 201));

    const client = createMockClient();

    await createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
      maxRetries: 0,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("uses exponential backoff with jitter between retries", async () => {
    const delays: number[] = [];
    mockFetch
      .mockRejectedValueOnce(new Error("Mattermost API 503 Service Unavailable"))
      .mockRejectedValueOnce(new Error("Mattermost API 503 Service Unavailable"))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-delay" }, 201));

    const client = createMockClient();

    await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        onRetry: (attempt, delayMs) => {
          delays.push(delayMs);
        },
      }),
    );

    expect(delays).toHaveLength(2);
    // First retry: exponentialDelay = 100ms, jitter = 0-100ms, total = 100-200ms
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(200);
    // Second retry: exponentialDelay = 200ms, jitter = 0-200ms, total = 200-400ms
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThanOrEqual(400);
  });

  it("respects maxDelayMs cap", async () => {
    const delays: number[] = [];
    mockFetch
      .mockRejectedValueOnce(new Error("Mattermost API 503"))
      .mockRejectedValueOnce(new Error("Mattermost API 503"))
      .mockRejectedValueOnce(new Error("Mattermost API 503"))
      .mockRejectedValueOnce(new Error("Mattermost API 503"))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-max" }, 201));

    const client = createMockClient();

    await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 4,
        initialDelayMs: 1000,
        maxDelayMs: 2500,
        onRetry: (attempt, delayMs) => {
          delays.push(delayMs);
        },
      }),
    );

    expect(delays).toHaveLength(4);
    // All delays should be capped at maxDelayMs
    delays.forEach((delay) => {
      expect(delay).toBeLessThanOrEqual(2500);
    });
  });

  it("does not retry on 4xx errors even if message contains retryable keywords", async () => {
    // This tests the fix for false positives where a 400 error with "timeout" in the message
    // would incorrectly be retried
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: "Request timeout: connection timed out" }, 400),
    );

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("400");

    // Should not retry - only called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 403 Forbidden even with 'abort' in message", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Request aborted: forbidden" }, 403));

    const client = createMockClient();

    const run = suppressUnhandled(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );
    await expect(resolveRetryRun(run)).rejects.toThrow("403");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes AbortSignal to fetch for timeout support", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((url, init) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve(jsonResponse({ id: "dm-channel-signal" }, 201));
    });

    const client = createMockClient();
    await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        timeoutMs: 5000,
      }),
    );

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("retries on 5xx even if error message contains 4xx substring", async () => {
    // This tests the fix for the ordering bug: 503 with "upstream 404" should be retried
    mockFetch
      .mockRejectedValueOnce(new Error("Mattermost API 503: upstream returned 404 Not Found"))
      .mockResolvedValueOnce(jsonResponse({ id: "dm-channel-5xx-with-404" }, 201));

    const client = createMockClient();

    const result = await resolveRetryRun(
      createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 10,
      }),
    );

    // Should retry and succeed on second attempt
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.id).toBe("dm-channel-5xx-with-404");
  });
});
