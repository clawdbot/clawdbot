// Covers safety timeouts around embedded-agent compaction calls.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

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
    // Hung compaction must not stall the agent turn indefinitely.
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
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("ok"), 10);
        }),
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
    // Run-level aborts should win over the safety timer and still trigger one
    // cancellation path.
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
  it("lets a progress-reporting compaction run past the total budget", async () => {
    // A slow-but-advancing compaction (e.g. reasoning-mode summarization of a
    // large context) finishes even though its total runtime exceeds timeoutMs.
    vi.useFakeTimers();
    const TIMEOUT = 30;
    let pulse: (() => void) | undefined;
    const compactPromise = compactWithSafetyTimeout(
      (_signal, onProgress) =>
        new Promise<string>((resolve) => {
          pulse = onProgress;
          // One advance per 20ms; total runtime 4x the budget.
          setTimeout(() => resolve("done"), 4 * TIMEOUT);
        }),
      TIMEOUT,
    );

    for (let elapsed = 0; elapsed <= 4 * TIMEOUT; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      pulse?.();
    }
    await expect(compactPromise).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a reporting compaction one budget after its last progress call", async () => {
    // Progress stops => silence budget applies from the LAST pulse, not from start.
    vi.useFakeTimers();
    const TIMEOUT = 30;
    let pulse: (() => void) | undefined;
    const compactPromise = compactWithSafetyTimeout(
      (_signal, onProgress) =>
        new Promise<never>(() => {
          pulse = onProgress;
        }),
      TIMEOUT,
    );
    const assertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(20);
    pulse?.(); // re-arms: abort must NOT fire at the original 30ms mark
    await vi.advanceTimersByTimeAsync(20);
    pulse?.();
    await vi.advanceTimersByTimeAsync(20); // 60ms since start, 20ms since last pulse: still live
    await vi.advanceTimersByTimeAsync(TIMEOUT); // TIMEOUT of silence
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a forever-pulsing compaction at the absolute ceiling", async () => {
    // A faulty engine that reports progress forever must not defer the bound
    // indefinitely: the absolute ceiling (10x the stall budget) is independent
    // of the re-armable stall timer.
    vi.useFakeTimers();
    const TIMEOUT = 30;
    let pulse: (() => void) | undefined;
    const compactPromise = compactWithSafetyTimeout(
      (_signal, onProgress) =>
        new Promise<never>(() => {
          pulse = onProgress;
        }),
      TIMEOUT,
    );
    const assertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    // Pulse every 20ms (never silent) well past many stall budgets…
    for (let elapsed = 0; elapsed < 10 * TIMEOUT; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      pulse?.();
    }
    // …the absolute ceiling fires at 10x regardless.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps the absolute ceiling to the Node-safe timer maximum", async () => {
    // A stall budget already at the shared timer maximum makes the 10x ceiling
    // overflow setTimeout's delay bound (Node fires overflowing delays after
    // ~1ms). The multiplied deadline must re-clamp, so a valid maximum
    // configuration aborts at the ceiling — not immediately, and not never.
    vi.useFakeTimers();
    let pulse: (() => void) | undefined;
    let rejected = false;
    const compactPromise = compactWithSafetyTimeout(
      (_signal, onProgress) =>
        new Promise<never>(() => {
          pulse = onProgress;
        }),
      MAX_TIMER_TIMEOUT_MS,
    );
    compactPromise.catch(() => {
      rejected = true;
    });

    // Progress keeps the stall timer alive; nothing may fire early — an
    // un-clamped 10x MAX delay overflows and would abort within ~1ms.
    await vi.advanceTimersByTimeAsync(10_000);
    pulse?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toBe(false);

    // The clamped ceiling equals the timer maximum and fires there while the
    // re-armed stall timer (10_000 + MAX) is still in the future.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    expect(rejected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores progress pulses after settle", async () => {
    vi.useFakeTimers();
    let pulse: (() => void) | undefined;
    const compactPromise = compactWithSafetyTimeout(
      (_signal, onProgress) =>
        new Promise<string>((resolve) => {
          pulse = onProgress;
          setTimeout(() => resolve("ok"), 10);
        }),
      30,
    );
    await vi.advanceTimersByTimeAsync(10);
    await expect(compactPromise).resolves.toBe("ok");
    expect(() => pulse?.()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on timeout even when cancellation settles the compaction first", async () => {
    // Timeout precedence: the production cancel hook (activeSession
    // .abortCompaction) can complete a cooperative compaction synchronously
    // when the timeout fires. That fulfillment must not beat the timeout
    // rejection out of the race — the rejection listener is registered as the
    // first observer of the timeout signal, ahead of the cancel hook.
    vi.useFakeTimers();
    let settleFromCancel: (() => void) | undefined;
    const compactPromise = compactWithSafetyTimeout(
      () =>
        new Promise<string>((resolve) => {
          settleFromCancel = () => resolve("completed-during-cancel");
        }),
      30,
      {
        onCancel: () => settleFromCancel?.(),
      },
    );
    const assertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
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
        agents: { defaults: { compaction: { timeoutSeconds: 120 } } },
      }),
    ).toBe(120_000);
  });

  it("preserves explicit timeoutSeconds above 600", () => {
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
    sessionKey: "agent:main:session-1",
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

  it("forwards onProgress to the plugin compact() params as a stall budget", async () => {
    // A reporting engine that advances steadily finishes past timeoutMs total.
    vi.useFakeTimers();
    const TIMEOUT = 30;
    let pulse: (() => void) | undefined;
    const result: CompactResult = {
      ok: true,
      compacted: true,
      result: { tokensBefore: 1000, tokensAfter: 200 },
    };
    const compact = vi.fn<CompactFn>((params) => {
      pulse = params.onProgress;
      return new Promise<CompactResult>((resolve) => {
        setTimeout(() => resolve(result), 4 * TIMEOUT);
      });
    });

    const pending = compactContextEngineWithSafetyTimeout({ compact }, baseParams, TIMEOUT);
    for (let elapsed = 0; elapsed < 4 * TIMEOUT; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      pulse?.();
    }
    await expect(pending).resolves.toBe(result);
    expect(typeof compact.mock.calls[0]?.[0].onProgress).toBe("function");
    expect(vi.getTimerCount()).toBe(0);
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
    // Plugin context engines receive an abort signal derived from the run signal
    // so they can stop work promptly.
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
    // Timeout cancellation is delivered through the same plugin abort signal as
    // external run cancellation.
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
