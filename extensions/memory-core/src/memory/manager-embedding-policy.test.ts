import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  isStructuredInputTooLargeMemoryEmbeddingError,
  resolveMemoryEmbeddingRetryDelay,
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

describe("memory embedding policy", () => {
  it("splits large files across multiple embedding batches", () => {
    const line = "a".repeat(4200);
    const batches = buildMemoryEmbeddingBatches([chunk(line), chunk(line)], 8000);

    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
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

  it("classifies oversized structured-input errors", () => {
    expect(isStructuredInputTooLargeMemoryEmbeddingError("payload too large")).toBe(true);
    expect(
      isStructuredInputTooLargeMemoryEmbeddingError(
        "gemini embeddings failed: request size exceeded input limit",
      ),
    ).toBe(true);
    expect(isStructuredInputTooLargeMemoryEmbeddingError("connection reset by peer")).toBe(false);
  });

  it("caps retry jittered delays", () => {
    expect(resolveMemoryEmbeddingRetryDelay(500, 0, 8000)).toBe(500);
    expect(resolveMemoryEmbeddingRetryDelay(500, 1, 8000)).toBe(600);
    expect(resolveMemoryEmbeddingRetryDelay(10_000, 1, 8000)).toBe(8000);
  });
});
