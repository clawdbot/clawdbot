// Fire-and-forget hook tests cover async hook execution without blocking callers.
import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { fireAndForgetBoundedHook, fireAndForgetHook } from "./fire-and-forget.js";

function requireFirstLog(logger: ReturnType<typeof vi.fn>): string {
  const [call] = logger.mock.calls;
  if (!call) {
    throw new Error("expected log call");
  }
  const [message] = call;
  if (typeof message !== "string") {
    throw new Error("expected string log message");
  }
  return message;
}

describe("fireAndForgetHook", () => {
  it("keeps truncated error logs free of lone surrogates", async () => {
    const logger = vi.fn();
    fireAndForgetHook(Promise.reject(new Error(`${"a".repeat(499)}😀tail`)), "hook", logger);
    await Promise.resolve();

    const message = requireFirstLog(logger);
    expect(Buffer.from(message).toString()).toBe(message);
  });

  it("logs rejection errors as sanitized single-line messages", async () => {
    const logger = vi.fn();
    fireAndForgetHook(
      Promise.reject(new Error("boom\nforged\tsecret sk-test1234567890")),
      "hook failed",
      logger,
    );
    await Promise.resolve();
    expect(logger).toHaveBeenCalledWith("hook failed: boom forged secret ***");
    const message = requireFirstLog(logger);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("sk-test1234567890");
  });

  it("does not log for resolved tasks", async () => {
    const logger = vi.fn();
    fireAndForgetHook(Promise.resolve("ok"), "hook failed", logger);
    await Promise.resolve();
    expect(logger).not.toHaveBeenCalled();
  });
});

describe("fireAndForgetBoundedHook", () => {
  it("limits queued fire-and-forget hooks", async () => {
    const logger = vi.fn();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const starts: string[] = [];

    fireAndForgetBoundedHook(
      async () => {
        starts.push("first");
        await first;
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );
    fireAndForgetBoundedHook(
      async () => {
        starts.push("second");
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );
    fireAndForgetBoundedHook(
      async () => {
        starts.push("third");
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );

    await vi.waitFor(() => {
      expect(starts).toEqual(["first"]);
    });
    expect(logger).toHaveBeenCalledWith("hook failed: queue full; dropping hook");

    resolveFirst?.();
    await vi.waitFor(() => {
      expect(starts).toEqual(["first", "second"]);
    });
  });

  it("caps oversized hook timeout timers", async () => {
    vi.useFakeTimers();
    try {
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const logger = vi.fn();

      fireAndForgetBoundedHook(async () => new Promise(() => {}), "hook failed", logger, {
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      expect(logger).toHaveBeenCalledWith(`hook failed: timed out after ${MAX_TIMER_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
  });
});
