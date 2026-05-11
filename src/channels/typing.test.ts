import { describe, expect, it, vi } from "vitest";
import { createTypingCallbacks } from "./typing.js";

type TypingCallbackOverrides = Partial<Parameters<typeof createTypingCallbacks>[0]>;
type TypingHarnessStart = ReturnType<typeof vi.fn<() => Promise<void>>>;
type TypingHarnessError = ReturnType<typeof vi.fn<(err: unknown) => void>>;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

function createTypingHarness(overrides: TypingCallbackOverrides = {}) {
  const start: TypingHarnessStart = vi.fn<() => Promise<void>>(async () => {});
  const stop: TypingHarnessStart = vi.fn<() => Promise<void>>(async () => {});
  const onStartError: TypingHarnessError = vi.fn<(err: unknown) => void>();
  const onStopError: TypingHarnessError = vi.fn<(err: unknown) => void>();

  if (overrides.start) {
    start.mockImplementation(overrides.start);
  }
  if (overrides.stop) {
    stop.mockImplementation(overrides.stop);
  }
  if (overrides.onStartError) {
    onStartError.mockImplementation(overrides.onStartError);
  }
  if (overrides.onStopError) {
    onStopError.mockImplementation(overrides.onStopError);
  }

  const callbacks = createTypingCallbacks({
    start,
    stop,
    onStartError,
    onStopError,
    ...(overrides.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: overrides.maxConsecutiveFailures }
      : {}),
    ...(overrides.maxDurationMs !== undefined ? { maxDurationMs: overrides.maxDurationMs } : {}),
  });
  return { start, stop, onStartError, onStopError, callbacks };
}

describe("createTypingCallbacks", () => {
  it("invokes start on reply start", async () => {
    const { start, onStartError, callbacks } = createTypingHarness();

    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("reports start errors", async () => {
    const { onStartError, callbacks } = createTypingHarness({
      start: vi.fn().mockRejectedValue(new Error("fail")),
    });

    await callbacks.onReplyStart();
    await flushMicrotasks();

    expect(onStartError).toHaveBeenCalledTimes(1);
  });

  it("does not block reply start on a pending typing request", async () => {
    let resolveStart: (() => void) | undefined;
    const { start, callbacks } = createTypingHarness({
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    });

    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(1);
    if (!resolveStart) {
      throw new Error("Expected typing start resolver to be initialized");
    }
    resolveStart();
  });

  it("invokes stop on idle and reports stop errors", async () => {
    const { stop, onStopError, callbacks } = createTypingHarness({
      stop: vi.fn().mockRejectedValue(new Error("stop")),
    });

    callbacks.onIdle?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopError).toHaveBeenCalledTimes(1);
  });

  it("sends typing keepalive pings until idle cleanup", async () => {
    await withFakeTimers(async () => {
      const { start, stop, callbacks } = createTypingHarness();
      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(3);

      callbacks.onIdle?.();
      await flushMicrotasks();
      expect(stop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(3);
    });
  });

  it("stops keepalive after consecutive start failures", async () => {
    await withFakeTimers(async () => {
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockRejectedValue(new Error("gone")),
      });
      await callbacks.onReplyStart();
      await flushMicrotasks();
      expect(start).toHaveBeenCalledTimes(1);
      expect(onStartError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(2);
      expect(onStartError).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it("does not restart keepalive when breaker trips on initial start", async () => {
    await withFakeTimers(async () => {
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockRejectedValue(new Error("gone")),
        maxConsecutiveFailures: 1,
      });

      await callbacks.onReplyStart();
      await flushMicrotasks();
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(onStartError).toHaveBeenCalledTimes(1);
    });
  });

  it("resets failure counter after a successful keepalive tick", async () => {
    await withFakeTimers(async () => {
      let callCount = 0;
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockImplementation(async () => {
          callCount += 1;
          if (callCount % 2 === 1) {
            throw new Error("flaky");
          }
        }),
        maxConsecutiveFailures: 2,
      });
      await callbacks.onReplyStart(); // fail
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3_000); // success
      await vi.advanceTimersByTimeAsync(3_000); // fail
      await vi.advanceTimersByTimeAsync(3_000); // success
      await vi.advanceTimersByTimeAsync(3_000); // fail

      expect(start).toHaveBeenCalledTimes(5);
      expect(onStartError).toHaveBeenCalledTimes(3);
    });
  });

  it("deduplicates stop across idle and cleanup", async () => {
    const { stop, callbacks } = createTypingHarness();

    callbacks.onIdle?.();
    callbacks.onCleanup?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not restart keepalive after idle cleanup", async () => {
    await withFakeTimers(async () => {
      const { start, stop, callbacks } = createTypingHarness();

      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(1);

      callbacks.onIdle?.();
      await flushMicrotasks();

      await callbacks.onReplyStart();
      await vi.advanceTimersByTimeAsync(9_000);

      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  // ========== TTL Safety Tests ==========
  describe("TTL safety", () => {
    it("auto-stops typing after maxDurationMs", async () => {
      await withFakeTimers(async () => {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { start, stop, callbacks } = createTypingHarness({ maxDurationMs: 10_000 });

        await callbacks.onReplyStart();
        expect(start).toHaveBeenCalledTimes(1);
        expect(stop).not.toHaveBeenCalled();

        // Advance past TTL
        await vi.advanceTimersByTimeAsync(10_000);

        // Should auto-stop
        expect(stop).toHaveBeenCalledTimes(1);
        expect(consoleWarn).toHaveBeenCalledWith(
          "[typing] TTL exceeded (10000ms), auto-stopping typing indicator",
        );

        consoleWarn.mockRestore();
      });
    });

    it("does not auto-stop if idle is called before TTL", async () => {
      await withFakeTimers(async () => {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { stop, callbacks } = createTypingHarness({ maxDurationMs: 10_000 });

        await callbacks.onReplyStart();

        // Stop before TTL
        await vi.advanceTimersByTimeAsync(5_000);
        callbacks.onIdle?.();
        await flushMicrotasks();

        expect(stop).toHaveBeenCalledTimes(1);

        // Advance past original TTL
        await vi.advanceTimersByTimeAsync(10_000);

        // Should not have triggered TTL warning
        expect(consoleWarn).not.toHaveBeenCalled();
        // Stop should still be called only once
        expect(stop).toHaveBeenCalledTimes(1);

        consoleWarn.mockRestore();
      });
    });

    it("uses default 60s TTL when not specified", async () => {
      await withFakeTimers(async () => {
        const { stop, callbacks } = createTypingHarness();

        await callbacks.onReplyStart();

        // Should not stop at 59s
        await vi.advanceTimersByTimeAsync(59_000);
        expect(stop).not.toHaveBeenCalled();

        // Should stop at 60s
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stop).toHaveBeenCalledTimes(1);
      });
    });

    it("disables TTL when maxDurationMs is 0", async () => {
      await withFakeTimers(async () => {
        const { stop, callbacks } = createTypingHarness({ maxDurationMs: 0 });

        await callbacks.onReplyStart();

        // Should not auto-stop even after long time
        await vi.advanceTimersByTimeAsync(300_000);
        expect(stop).not.toHaveBeenCalled();
      });
    });

    it("resets TTL timer on restart after idle", async () => {
      await withFakeTimers(async () => {
        const { stop, callbacks } = createTypingHarness({ maxDurationMs: 10_000 });

        // First start
        await callbacks.onReplyStart();
        await vi.advanceTimersByTimeAsync(5_000);

        // Idle and restart
        callbacks.onIdle?.();
        await flushMicrotasks();
        expect(stop).toHaveBeenCalledTimes(1);

        // Reset mock to track second start
        stop.mockClear();

        // After stop, callbacks are closed, so new onReplyStart should be no-op
        await callbacks.onReplyStart();
        await vi.advanceTimersByTimeAsync(15_000);

        // Should not trigger stop again since it's closed
        expect(stop).not.toHaveBeenCalled();
      });
    });
  });
});
