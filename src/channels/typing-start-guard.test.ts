// Typing start guard tests cover debounce and safety checks before starting typing indicators.
import { describe, expect, it, vi } from "vitest";
import { createTypingStartGuard } from "./typing-start-guard.js";

describe("createTypingStartGuard", () => {
  it("skips starts when sealed", async () => {
    const start = vi.fn();
    const guard = createTypingStartGuard({
      isSealed: () => true,
    });

    const result = await guard.run(start);
    expect(result).toBe("skipped");
    expect(start).not.toHaveBeenCalled();
  });

  it("trips breaker after max consecutive failures", async () => {
    const onStartError = vi.fn();
    const onTrip = vi.fn();
    const guard = createTypingStartGuard({
      isSealed: () => false,
      onStartError,
      onTrip,
      maxConsecutiveFailures: 2,
    });
    const start = vi.fn().mockRejectedValue(new Error("fail"));

    const first = await guard.run(start);
    const second = await guard.run(start);
    const third = await guard.run(start);

    expect(first).toBe("failed");
    expect(second).toBe("tripped");
    expect(third).toBe("skipped");
    expect(onStartError).toHaveBeenCalledTimes(2);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("resets breaker state", async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 1,
    });
    const failStart = vi.fn().mockRejectedValue(new Error("fail"));
    const okStart = vi.fn().mockResolvedValue(undefined);

    const trip = await guard.run(failStart);
    expect(trip).toBe("tripped");
    expect(guard.isTripped()).toBe(true);

    guard.reset();
    const started = await guard.run(okStart);
    expect(started).toBe("started");
    expect(guard.isTripped()).toBe(false);
  });

  it("rethrows start errors when configured", async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      rethrowOnError: true,
    });
    const start = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(guard.run(start)).rejects.toThrow("boom");
  });
});
