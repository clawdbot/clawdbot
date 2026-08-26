// Memory Core tests cover manager embedding policy plugin behavior.
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  filterNonEmptyMemoryChunks,
  isMemoryEmbeddingProviderAccessError,
  isRetryableMemoryEmbeddingError,
  isSplittableMemoryEmbeddingTransportError,
  resolveMemoryEmbeddingRetryDelay,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";

function chunk(text: string) {
  return {
    startLine: 1,
    endLine: 1,
    text,
    hash: text,
  };
}

function providerHttpError(
  status: number,
  message: string,
  extra?: { code?: string; errorType?: string; retryAfterMs?: number },
) {
  return Object.assign(new Error(message), { status, ...extra });
}

function quotaExhaustedError() {
  return providerHttpError(429, "openai embeddings failed: 429 You have no credits remaining.", {
    code: "credit_balance_exhausted",
    errorType: "insufficient_quota",
  });
}

describe("memory embedding policy", () => {
  it("splits large files across multiple embedding batches", () => {
    const line = "a".repeat(4200);
    const batches = buildMemoryEmbeddingBatches([chunk(line), chunk(line)], 8000);

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("keeps small files in a single embedding batch", () => {
    const line = "b".repeat(120);
    const batches = buildMemoryEmbeddingBatches(
      [chunk(line), chunk(line), chunk(line), chunk(line)],
      8000,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  it("filters empty chunks before embedding", () => {
    const chunks = filterNonEmptyMemoryChunks([chunk("\n\n"), chunk("hello"), chunk("   ")]);

    expect(chunks.map((entry) => entry.text)).toEqual(["hello"]);
  });

  it("retries transient rate limit and 5xx errors", async () => {
    const run = vi.fn(async () => {
      const call = run.mock.calls.length;
      if (call === 1) {
        throw new Error("openai embeddings failed: 429 rate limit");
      }
      if (call === 2) {
        throw new Error("openai embeddings failed: 502 Bad Gateway (cloudflare)");
      }
      return "ok";
    });
    const waits: number[] = [];

    const result = await runMemoryEmbeddingRetryLoop({
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("stops retrying after the caller signal aborts, even for retryable-looking errors", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort(new Error("memory_search timed out after 15s"));
      // "timed out" matches the retryable transport pattern; abort must still win.
      throw new Error("memory embeddings query timed out after 60s");
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 3,
        baseDelayMs: 500,
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory embeddings query timed out after 60s");

    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("aborts an in-progress retry delay without starting another provider request", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const abortReason = new Error("memory search was cancelled");
      const run = vi.fn(async () => {
        throw new Error("memory embeddings query timed out after 60s");
      });
      const waitForRetry = vi.fn(async (delayMs: number) => {
        await sleepWithAbort(delayMs, controller.signal);
      });

      const pending = runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 3,
        baseDelayMs: 500,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(run).toHaveBeenCalledOnce();
      expect(waitForRetry).toHaveBeenCalledWith(500);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort(abortReason);

      await expect(pending).rejects.toMatchObject({
        message: "aborted",
        cause: abortReason,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves permanent provider error identity without retrying", async () => {
    const permanentError = new Error("embedding validation failed");
    const run = vi.fn(async () => {
      throw permanentError;
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 3,
        baseDelayMs: 500,
      }),
    ).rejects.toBe(permanentError);

    expect(run).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("retries transient socket/network embedding errors", () => {
    const splittableMessages = [
      "TypeError: fetch failed | other side closed",
      "undici error: UND_ERR_SOCKET",
      "read ECONNRESET",
      "socket hang up",
    ];

    for (const message of splittableMessages) {
      expect(isRetryableMemoryEmbeddingError(message)).toBe(true);
      expect(isSplittableMemoryEmbeddingTransportError(message)).toBe(true);
    }
    expect(isRetryableMemoryEmbeddingError("ECONNREFUSED")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("ECONNREFUSED")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("EHOSTUNREACH")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("EHOSTUNREACH")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("memory embeddings batch timed out")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("memory embeddings batch timed out")).toBe(
      false,
    );
    expect(isRetryableMemoryEmbeddingError("worker terminated by user")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("embedding validation failed")).toBe(false);
  });

  it("classifies structured provider statuses ahead of message text", () => {
    expect(isRetryableMemoryEmbeddingError(quotaExhaustedError())).toBe(false);
    // Legacy shape: some responses only carry insufficient_quota as the code.
    expect(
      isRetryableMemoryEmbeddingError(
        providerHttpError(429, "openai embeddings failed: 429 quota", {
          code: "insufficient_quota",
        }),
      ),
    ).toBe(false);
    expect(
      isRetryableMemoryEmbeddingError(
        providerHttpError(429, "openai embeddings failed: 429 rate limited"),
      ),
    ).toBe(true);
    expect(
      isRetryableMemoryEmbeddingError(providerHttpError(503, "voyage embeddings failed: 503 busy")),
    ).toBe(true);
    // A definitive 4xx is terminal even when its body mentions a retryable phrase.
    expect(
      isRetryableMemoryEmbeddingError(
        providerHttpError(400, "openai embeddings failed: 400 rate limit docs at ..."),
      ),
    ).toBe(false);
  });

  it("reads structured facts through operation-error wrappers", () => {
    const wrapped = Object.assign(new Error("wrapped"), {
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      cause: quotaExhaustedError(),
    });

    expect(isRetryableMemoryEmbeddingError(wrapped)).toBe(false);
    expect(isMemoryEmbeddingProviderAccessError(wrapped)).toBe(true);
  });

  it("does not treat payload numbers in provider messages as HTTP statuses", () => {
    expect(
      isRetryableMemoryEmbeddingError(
        "gemini embeddings failed: expected 512 dimensions, received 3",
      ),
    ).toBe(false);
    expect(isRetryableMemoryEmbeddingError("chunk 4290 of 5000 rejected")).toBe(false);
    expect(
      isRetryableMemoryEmbeddingError("GitHub Copilot model discovery HTTP 429: slow down"),
    ).toBe(true);
    expect(isRetryableMemoryEmbeddingError("request failed with status code 502")).toBe(true);
  });

  it("classifies account-level access errors for degradation", () => {
    expect(isMemoryEmbeddingProviderAccessError(quotaExhaustedError())).toBe(true);
    expect(isMemoryEmbeddingProviderAccessError(providerHttpError(401, "unauthorized"))).toBe(true);
    expect(isMemoryEmbeddingProviderAccessError(providerHttpError(402, "payment required"))).toBe(
      true,
    );
    expect(isMemoryEmbeddingProviderAccessError(providerHttpError(403, "forbidden"))).toBe(true);
    expect(isMemoryEmbeddingProviderAccessError(providerHttpError(429, "plain rate limit"))).toBe(
      false,
    );
    expect(isMemoryEmbeddingProviderAccessError(providerHttpError(500, "server error"))).toBe(
      false,
    );
    expect(isMemoryEmbeddingProviderAccessError(new Error("fetch failed"))).toBe(false);
  });

  it("stops retrying exhausted-quota provider errors after the first attempt", async () => {
    const run = vi.fn(async () => {
      throw quotaExhaustedError();
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 3,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("You have no credits remaining");

    expect(run).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("honors Retry-After hints for genuine rate-limit 429s", async () => {
    const waits: number[] = [];
    let calls = 0;

    const result = await runMemoryEmbeddingRetryLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw providerHttpError(429, "openai embeddings failed: 429 rate limited", {
            retryAfterMs: 20_000,
          });
        }
        return "ok";
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([20_000]);
  });

  it("caps oversized Retry-After hints so the sync slot cannot be camped", async () => {
    const waits: number[] = [];
    let calls = 0;

    await runMemoryEmbeddingRetryLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw providerHttpError(429, "openai embeddings failed: 429 rate limited", {
            retryAfterMs: 120_000,
          });
        }
        return "ok";
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 2,
      baseDelayMs: 500,
    });

    expect(waits).toEqual([30_000]);
  });

  it("splits OpenAI 431 oversized embedding batches without retrying the same request", async () => {
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw new Error(
          "openai embeddings failed: 431 request_headers_too_large: Request Header Fields Too Large",
        );
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });

    const result = await runMemoryEmbeddingBatchRetryWithSplit({
      items: ["a", "b", "c", "d"],
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      isSplittable: isSplittableMemoryEmbeddingTransportError,
      waitForRetry: async () => {},
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toEqual([[97], [98], [99], [100]]);
    expect(run.mock.calls.map(([items]) => items.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(isRetryableMemoryEmbeddingError("431 request_headers_too_large")).toBe(false);
    expect(isSplittableMemoryEmbeddingTransportError("431 request_headers_too_large")).toBe(true);
    expect(
      isSplittableMemoryEmbeddingTransportError("embedding validation failed at item 4312"),
    ).toBe(false);
  });

  it("retries too-many-tokens-per-day errors", async () => {
    let calls = 0;
    const waits: number[] = [];

    const result = await runMemoryEmbeddingRetryLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("AWS Bedrock embeddings failed: Too many tokens per day");
        }
        return "ok";
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([500]);
  });

  it("stops after the configured maximum attempts", async () => {
    const run = vi.fn(async () => {
      throw new Error("TypeError: fetch failed | other side closed");
    });
    const waits: number[] = [];

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("fetch failed");

    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("splits transport-failed batches after retries are exhausted", async () => {
    const waits: number[] = [];
    const splits: string[] = [];
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw new TypeError("fetch failed | other side closed");
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });

    const result = await runMemoryEmbeddingBatchRetryWithSplit({
      items: ["a", "b", "c", "d"],
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      isSplittable: isSplittableMemoryEmbeddingTransportError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 2,
      baseDelayMs: 500,
      onSplit: ({ itemCount, splitAt }) => {
        splits.push(`${itemCount}:${splitAt}`);
      },
    });

    expect(result).toEqual([[97], [98], [99], [100]]);
    expect(run.mock.calls.map(([items]) => items.length)).toEqual([4, 4, 2, 2, 1, 1, 2, 2, 1, 1]);
    expect(waits).toEqual([500, 500, 500]);
    expect(splits).toEqual(["4:2", "2:1", "2:1"]);
  });

  it("does not split exhausted service retry errors", async () => {
    const run = vi.fn(async () => {
      throw new Error("openai embeddings failed: 429 rate limit");
    });

    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b"],
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async () => {},
        maxAttempts: 1,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("429 rate limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not split whole-endpoint transport outages", async () => {
    const run = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });

    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b"],
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async () => {},
        maxAttempts: 2,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caps retry jittered delays", () => {
    expect(resolveMemoryEmbeddingRetryDelay(500, 0, 8000)).toBe(500);
    expect(resolveMemoryEmbeddingRetryDelay(500, 1, 8000)).toBe(600);
    expect(resolveMemoryEmbeddingRetryDelay(10_000, 1, 8000)).toBe(8000);
  });
});
