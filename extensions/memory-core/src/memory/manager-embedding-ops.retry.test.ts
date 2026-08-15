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
    resolveEmbeddingTimeout: () => 60_000,
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
});

describe("memory embedding query cooldown recovery", () => {
  type CooldownState = {
    providerId: string;
    untilMs: number;
    reason: string;
    consecutiveFailures: number;
  };

  it("skips the provider entirely while an active billing cooldown covers it", async () => {
    // Regression: only the batch path checked embeddingBillingCooldown before calling the
    // provider. Vector-search queries reach embedQueryWithRetry directly, so a billing-
    // exhausted provider kept receiving query traffic (and paying/failing on every search)
    // during a cooldown the batch path had already entered.
    const embedQuery = vi.fn<EmbeddingProvider["embedQuery"]>().mockResolvedValue([0.1, 0.2]);
    const manager = createEmbeddingQueryRetryHarness(embedQuery) as EmbeddingQueryRetryHarness & {
      embeddingBillingCooldown?: CooldownState;
    };
    manager.embeddingBillingCooldown = {
      providerId: "test-provider",
      untilMs: Date.now() + 60_000,
      reason: "402 payment required",
      consecutiveFailures: 1,
    };

    await expect(manager.embedQueryWithRetry("search terms")).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
    });
    expect(embedQuery).not.toHaveBeenCalled();
    expect(manager.embeddingBillingCooldown).toBeDefined();
  });

  it("clears an active billing cooldown once a query embedding succeeds after it expires", async () => {
    // Regression: only the batch-write success path cleared embeddingBillingCooldown, so
    // after credits were restored, memory search could succeed via embedQueryWithRetry
    // while every session write stayed skipped until the old cooldown deadline.
    const embedQuery = vi.fn<EmbeddingProvider["embedQuery"]>().mockResolvedValue([0.1, 0.2]);
    const manager = createEmbeddingQueryRetryHarness(embedQuery) as EmbeddingQueryRetryHarness & {
      embeddingBillingCooldown?: CooldownState;
    };
    manager.embeddingBillingCooldown = {
      providerId: "test-provider",
      untilMs: Date.now() - 1,
      reason: "402 payment required",
      consecutiveFailures: 1,
    };

    await manager.embedQueryWithRetry("search terms");

    expect(embedQuery).toHaveBeenCalledOnce();
    expect(manager.embeddingBillingCooldown).toBeUndefined();
  });

  it("enters a billing cooldown when a query fails with a billing-exhausted error", async () => {
    const embedQuery = vi
      .fn<EmbeddingProvider["embedQuery"]>()
      .mockRejectedValue(new Error("402 payment required: insufficient_quota"));
    const manager = createEmbeddingQueryRetryHarness(embedQuery) as EmbeddingQueryRetryHarness & {
      embeddingBillingCooldown?: CooldownState;
    };

    await expect(manager.embedQueryWithRetry("search terms")).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
    });

    expect(manager.embeddingBillingCooldown?.providerId).toBe("test-provider");
  });
});
