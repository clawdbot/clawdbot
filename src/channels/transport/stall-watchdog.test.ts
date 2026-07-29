// Transport stall watchdog tests cover timer bounds and stalled channel transport detection.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createArmableStallWatchdog } from "./stall-watchdog.js";

function createTestWatchdog(
  onTimeout: Parameters<typeof createArmableStallWatchdog>[0]["onTimeout"],
) {
  return createArmableStallWatchdog({
    label: "test-watchdog",
    timeoutMs: 1_000,
    checkIntervalMs: 100,
    onTimeout,
  });
}

describe("createArmableStallWatchdog", () => {
  it("fires onTimeout once when armed and idle exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(watchdog.isArmed()).toBe(false);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when disarmed before timeout", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(500);
      watchdog.disarm();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(onTimeout).not.toHaveBeenCalled();
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends timeout window when touched", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(700);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(700);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized timeout and check interval values before scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const onTimeout = vi.fn();
      const intervalSpy = vi.spyOn(globalThis, "setInterval");
      const watchdog = createArmableStallWatchdog({
        label: "test-watchdog",
        timeoutMs: Number.MAX_SAFE_INTEGER,
        checkIntervalMs: Number.MAX_SAFE_INTEGER,
        onTimeout,
      });

      watchdog.arm(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(onTimeout).not.toHaveBeenCalled();
      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
