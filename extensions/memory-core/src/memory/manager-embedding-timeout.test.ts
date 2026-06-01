import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveEmbeddingTimeoutMs,
  resolveMemoryIndexConcurrency,
  runEmbeddingOperationWithTimeout,
} from "./manager-embedding-ops.js";
import {
  isLocalEmbeddingWorkerFailure,
  LOCAL_EMBEDDING_WORKER_ERROR_CODES,
} from "./manager-local-worker-errors.js";

describe("memory embedding timeout resolution", () => {
  it("uses hosted defaults for inline embedding calls", () => {
    expect(resolveEmbeddingTimeoutMs({ kind: "query", providerId: "openai" })).toBe(60_000);
    expect(resolveEmbeddingTimeoutMs({ kind: "batch", providerId: "openai" })).toBe(120_000);
  });

  it("uses local defaults for the builtin local provider", () => {
    expect(resolveEmbeddingTimeoutMs({ kind: "query", providerId: "local" })).toBe(300_000);
    expect(resolveEmbeddingTimeoutMs({ kind: "batch", providerId: "local" })).toBe(600_000);
  });

  it("uses runtime batch defaults for local-server providers", () => {
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "ollama",
        providerRuntime: { inlineBatchTimeoutMs: 600_000 },
      }),
    ).toBe(600_000);
  });

  it("lets configured batch timeout override provider defaults", () => {
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "ollama",
        providerRuntime: { inlineBatchTimeoutMs: 600_000 },
        configuredBatchTimeoutSeconds: 45,
      }),
    ).toBe(45_000);
  });

  it("caps configured and runtime embedding timeouts to timer-safe values", () => {
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "openai",
        configuredBatchTimeoutSeconds: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "query",
        providerId: "openai",
        providerRuntime: { inlineQueryTimeoutMs: Number.MAX_SAFE_INTEGER },
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveEmbeddingTimeoutMs({
        kind: "batch",
        providerId: "openai",
        providerRuntime: { inlineBatchTimeoutMs: Number.MAX_SAFE_INTEGER },
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});

describe("local embedding worker failure detection", () => {
  it("matches structured local worker failure codes", () => {
    expect(
      isLocalEmbeddingWorkerFailure(
        Object.assign(new Error("Local embedding worker exited unexpectedly (exit code 134)"), {
          code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.exited,
          reason: "exit",
        }),
      ),
    ).toBe(true);
    expect(
      isLocalEmbeddingWorkerFailure(
        Object.assign(new Error("Local embedding worker process failed"), {
          code: LOCAL_EMBEDDING_WORKER_ERROR_CODES.processError,
          reason: "process-error",
        }),
      ),
    ).toBe(true);
    expect(
      isLocalEmbeddingWorkerFailure(
        Object.assign(new Error("Local embedding request aborted"), {
          code: "ABORT_ERR",
        }),
      ),
    ).toBe(false);
  });
});

describe("memory embedding timeout abort", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts the provider operation when the timeout fires", async () => {
    let signalSeen: AbortSignal | undefined;

    await expect(
      runEmbeddingOperationWithTimeout({
        timeoutMs: 1,
        message: "memory embeddings query timed out after 0s",
        run: async (signal) => {
          signalSeen = signal;
          return await new Promise<number[]>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
              { once: true },
            );
          });
        },
      }),
    ).rejects.toThrow("memory embeddings query timed out after 0s");

    expect(signalSeen?.aborted).toBe(true);
  });

  it("keeps the timeout error when a provider abort listener rejects generically", async () => {
    await expect(
      runEmbeddingOperationWithTimeout({
        timeoutMs: 1,
        message: "memory embeddings batch timed out after 0s",
        run: async (signal) =>
          await new Promise<number[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
              once: true,
            });
          }),
      }),
    ).rejects.toThrow("memory embeddings batch timed out after 0s");
  });

  it("caps operation watchdog timers before scheduling", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);

    try {
      await runEmbeddingOperationWithTimeout({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        message: "memory embeddings query timed out",
        run: async () => [1, 2, 3],
      });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("memory index concurrency resolution", () => {
  it("uses the default index concurrency when batch mode is disabled and unconfigured", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 2 },
      }),
    ).toBe(4);
  });

  it("respects configured non-batch concurrency when batch mode is disabled", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 1 },
        configuredNonBatchConcurrency: 1,
      }),
    ).toBe(1);
  });

  it("clamps configured non-batch concurrency to a positive integer", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 2 },
        configuredNonBatchConcurrency: 2.8,
      }),
    ).toBe(2);
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 2 },
        configuredNonBatchConcurrency: 0,
      }),
    ).toBe(1);
  });

  it("uses conservative non-batch concurrency for Ollama by default", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: false, concurrency: 2 },
        providerId: "ollama",
      }),
    ).toBe(1);
  });

  it("uses resolved batch concurrency when batch mode is enabled", () => {
    expect(
      resolveMemoryIndexConcurrency({
        batch: { enabled: true, concurrency: 3 },
      }),
    ).toBe(3);
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
