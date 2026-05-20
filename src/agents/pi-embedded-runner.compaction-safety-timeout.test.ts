import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  EMBEDDED_COMPACTION_TIMEOUT_MS,
  resolveCompactionTimeoutMs,
} from "./pi-embedded-runner/compaction-safety-timeout.js";

describe("compactWithSafetyTimeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rejects with timeout when compaction never settles", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}));
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns result and clears timer when compaction settles first", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10)),
      30,
    );

    await vi.advanceTimersByTimeAsync(10);
    await expect(compactPromise).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves compaction errors and clears timer", async () => {
    vi.useFakeTimers();
    const error = new Error("provider exploded");

    await expect(
      compactWithSafetyTimeout(async () => {
        throw error;
      }, 30),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls onCancel when compaction times out", async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel,
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts early on external abort signal and calls onCancel once", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const reason = new Error("request timed out");

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 100, {
      abortSignal: controller.signal,
      onCancel,
    });
    const abortAssertion = expect(compactPromise).rejects.toBe(reason);

    controller.abort(reason);
    await abortAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores onCancel errors and still rejects with the timeout", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel: () => {
        throw new Error("abortCompaction failed");
      },
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveCompactionTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveCompactionTimeoutMs(undefined)).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default when compaction config is missing", () => {
    expect(resolveCompactionTimeoutMs({ agents: { defaults: {} } })).toBe(
      EMBEDDED_COMPACTION_TIMEOUT_MS,
    );
  });

  it("returns default when timeoutSeconds is not set", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { mode: "safeguard" } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("converts timeoutSeconds to milliseconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 1800 } } },
      }),
    ).toBe(1_800_000);
  });

  it("floors fractional seconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 120.7 } } },
      }),
    ).toBe(120_000);
  });

  it("returns default for zero", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: 0 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for negative values", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: -5 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for NaN", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Number.NaN } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for Infinity", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Infinity } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });
});

describe("compactContextEngineWithSafetyTimeout", () => {
  type CompactFn = ContextEngine["compact"];
  const baseParams: Parameters<CompactFn>[0] = {
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    tokenBudget: 100_000,
    force: true,
  };

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("bounds a hung plugin compact() and rejects with a timeout error", async () => {
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the plugin compact() result when it settles in time", async () => {
    const result: CompactResult = {
      ok: true,
      compacted: true,
      result: { tokensBefore: 1000, tokensAfter: 200 },
    };
    const compact = vi.fn<CompactFn>(async () => result);

    await expect(compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30)).resolves.toBe(
      result,
    );
  });

  it("threads a signal that follows the run abort signal into the plugin compact() params", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("run aborted");
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      30,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(reason);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    controller.abort(reason);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("threads the host timeout abort signal into the plugin compact() params", async () => {
    vi.useFakeTimers();
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBeInstanceOf(Error);
    expect((compactAbortSignal?.reason as Error | undefined)?.message).toBe("Compaction timed out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects promptly when the run abort signal fires before the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(
      { compact },
      baseParams,
      EMBEDDED_COMPACTION_TIMEOUT_MS,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(abortError);

    controller.abort(abortError);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a thrown plugin compaction error", async () => {
    const error = new Error("engine compaction failed");
    const compact = vi.fn<CompactFn>(async () => {
      throw error;
    });

    await expect(compactContextEngineWithSafetyTimeout({ compact }, baseParams, 30)).rejects.toBe(
      error,
    );
  });
});
