import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type EmbeddingQueryRetryHarness = {
  provider: EmbeddingProvider;
  embedQueryWithRetry: (text: string, signal?: AbortSignal) => Promise<number[]>;
  markLocalEmbeddingProviderDegraded: (error: unknown) => void;
  resolveEmbeddingTimeout: () => number;
  withProviderUse: <T>(provider: EmbeddingProvider, run: () => Promise<T>) => Promise<T>;
};

function createEmbeddingQueryRetryHarness(
  embedQuery: EmbeddingProvider["embedQuery"],
  timeoutMs = 60_000,
): EmbeddingQueryRetryHarness {
  const provider: EmbeddingProvider = {
    id: "test-provider",
    model: "test-embedding-model",
    embedQuery,
    embedBatch: async () => [],
  };

  // Exercise the real query and retry methods without opening an unrelated
  // memory index or acquiring an external embedding provider.
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    resolveEmbeddingTimeout: () => timeoutMs,
    markLocalEmbeddingProviderDegraded: vi.fn(),
    withProviderUse: async <T>(_provider: EmbeddingProvider, run: () => Promise<T>) => await run(),
  }) as EmbeddingQueryRetryHarness;
}

describe("memory embedding query retry cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels provider backoff immediately without sending a second request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortReason = new Error("memory search was cancelled");
    const embedQuery = vi
      .fn<EmbeddingProvider["embedQuery"]>()
      .mockRejectedValue(new Error("TypeError: fetch failed"));
    const manager = createEmbeddingQueryRetryHarness(embedQuery);

    const pending = manager.embedQueryWithRetry("search terms", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(embedQuery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(abortReason);

    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: { message: "aborted", cause: abortReason },
    });
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a provider request for an already-cancelled search", async () => {
    const abortReason = new Error("memory search was cancelled");
    const embedQuery = vi.fn<EmbeddingProvider["embedQuery"]>();
    const manager = createEmbeddingQueryRetryHarness(embedQuery);

    await expect(
      manager.embedQueryWithRetry("search terms", AbortSignal.abort(abortReason)),
    ).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: abortReason,
    });
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("retries provider success that arrives after each embedding deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operationSignals: AbortSignal[] = [];
    const embedQuery = vi.fn<EmbeddingProvider["embedQuery"]>(async (_text, options) => {
      if (options?.signal) {
        operationSignals.push(options.signal);
      }
      vi.setSystemTime(Date.now() + 11);
      return [1, 0, 0, 0];
    });
    const manager = createEmbeddingQueryRetryHarness(embedQuery, 10);
    const pending = manager.embedQueryWithRetry("search terms");
    void pending.catch(() => {});

    await vi.runAllTimersAsync();

    const timeoutMessage = "memory embeddings query timed out after 0s";
    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: { message: timeoutMessage },
    });
    expect(embedQuery).toHaveBeenCalledTimes(3);
    expect(operationSignals).toHaveLength(3);
    expect(operationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(operationSignals.every((signal) => signal.reason?.message === timeoutMessage)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
