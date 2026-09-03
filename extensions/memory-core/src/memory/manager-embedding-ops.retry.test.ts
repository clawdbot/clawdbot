import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
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
  embedQuery: EmbeddingProvider["embed"],
  timeoutMs = 60_000,
): EmbeddingQueryRetryHarness {
  const provider: EmbeddingProvider = {
    id: "test-provider",
    model: "test-embedding-model",
    embed: embedQuery,
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

function createEmbeddingBatchRetryHarness(embedBatch: EmbeddingProvider["embedBatch"]) {
  const manager = Object.assign(
    createEmbeddingQueryRetryHarness(async () => []),
    {
      waitForEmbeddingRetry: vi.fn(async () => {}),
    },
  ) as EmbeddingQueryRetryHarness & {
    embedBatchWithRetry: (texts: string[]) => Promise<number[][]>;
    waitForEmbeddingRetry: ReturnType<typeof vi.fn>;
  };
  manager.provider.embedBatch = embedBatch;
  return manager;
}

describe("memory embedding query retry cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels provider backoff immediately without sending a second request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortReason = new Error("memory search was cancelled");
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(
      Object.assign(new Error("gemini embeddings failed (429)"), {
        status: 429,
        retryAfterMs: 60_000,
      }),
    );
    const manager = createEmbeddingQueryRetryHarness(embedQuery, 10_000);
    const waitForRetrySpy = vi.spyOn(
      manager as unknown as {
        waitForEmbeddingRetry: (
          delayMs: number,
          action: string,
          signal?: AbortSignal,
        ) => Promise<void>;
      },
      "waitForEmbeddingRetry",
    );

    const pending = manager.embedQueryWithRetry("search terms", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(embedQuery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    const firstDelayMs = waitForRetrySpy.mock.calls[0]?.[0];
    expect(firstDelayMs).toBeGreaterThanOrEqual(6400);
    expect(firstDelayMs).toBeLessThanOrEqual(8000);

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
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>();
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

  it("reaches caller fallback within the memory_search deadline after a hinted 429", async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(
      Object.assign(new Error("gemini embeddings failed (429)"), {
        status: 429,
        retryAfterMs: 60_000,
      }),
    );
    const manager = Object.assign(createEmbeddingQueryRetryHarness(embedQuery), {
      waitForEmbeddingRetry: async (delayMs: number, _action: string, signal?: AbortSignal) => {
        waits.push(delayMs);
        await sleepWithAbort(delayMs, signal);
      },
    }) as EmbeddingQueryRetryHarness;
    const fallback = vi.fn(async () => [0, 1, 0, 0]);

    const pending = manager.embedQueryWithRetry("search terms").catch(fallback);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual([0, 1, 0, 0]);
    expect(embedQuery).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledOnce();
    expect(waits.every((delayMs) => delayMs <= 8_000)).toBe(true);
    expect(waits.reduce((total, delayMs) => total + delayMs, 0)).toBeLessThan(15_000);
  });

  it("retries provider success that arrives after each embedding deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operationSignals: AbortSignal[] = [];
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>(async (_input, options) => {
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

describe("memory embedding batch retry boundary", () => {
  it.each([
    [
      "explicit maximum and actual input counts",
      (count: number) =>
        `Embeddings API input limit exceeded: max 10, got ${count}. Request id: fixture-000597000`,
    ],
    ["an explicit maximum input length", () => "embeddings max input length is 10"],
  ])(
    "splits provider errors with %s without retrying oversized requests",
    async (_label, error) => {
      const items = Array.from({ length: 33 }, (_, index) => `item-${index}`);
      const embedBatch = vi.fn<EmbeddingProvider["embedBatch"]>(async (inputs) => {
        const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
        if (texts.length > 10) {
          throw new Error(`openai-compatible embeddings failed: HTTP 400: ${error(texts.length)}`);
        }
        return texts.map((text) => [Number.parseInt(text.slice(5), 10)]);
      });
      const manager = createEmbeddingBatchRetryHarness(embedBatch);

      await expect(manager.embedBatchWithRetry(items)).resolves.toEqual(
        items.map((_, index) => [index]),
      );
      expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([
        33, 17, 9, 8, 16, 8, 8,
      ]);
      expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
      expect(manager.markLocalEmbeddingProviderDegraded).not.toHaveBeenCalled();
    },
  );

  it("does not retry or split generic input validation errors containing request-id digits", async () => {
    const embedBatch = vi.fn(async () => {
      throw new Error(
        'openai-compatible embeddings failed: HTTP 400: {"error":{"code":"InvalidParameter","message":"The parameter input specified in the request is not valid. Request id: fixture-000597000","param":"input"}}',
      );
    });
    const manager = createEmbeddingBatchRetryHarness(embedBatch);

    await expect(manager.embedBatchWithRetry(["one", "two"])).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "batch",
    });
    expect(embedBatch).toHaveBeenCalledOnce();
    expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
    expect(manager.markLocalEmbeddingProviderDegraded).toHaveBeenCalledOnce();
  });
});
