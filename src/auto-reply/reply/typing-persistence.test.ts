import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Tests typing mode persistence across session updates and reply turns.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should NOT restart typing after markRunComplete is called", async () => {
    // Start typing normally
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run as complete (but not yet dispatch idle)
    controller.markRunComplete();

    // Advance time to trigger the typing interval (6 seconds)
    vi.advanceTimersByTime(6000);

    // BUG: The typing loop should NOT call onReplyStart again
    // because the run is already complete
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    expect(onReplyStartSpy).not.toHaveBeenCalledTimes(2);
  });

  it("keeps typing alive while keepalive ticks continue during long runs", async () => {
    const longRunCleanupSpy = vi.fn();
    const longRunController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: longRunCleanupSpy,
      typingIntervalSeconds: 6,
      typingTtlMs: 10_000,
      log: vi.fn(),
    });

    await longRunController.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(longRunCleanupSpy).not.toHaveBeenCalled();

    longRunController.cleanup();
    expect(longRunCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    vi.advanceTimersByTime(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it.each(["cleanup", "run-first", "idle-first"] as const)(
    "disposes typing when %s closes the controller before start settles",
    async (completion) => {
      const starting = controller.startTypingLoop();
      if (completion === "cleanup") {
        controller.cleanup();
      } else if (completion === "run-first") {
        controller.markRunComplete();
        controller.markDispatchIdle();
      } else {
        controller.markDispatchIdle();
        controller.markRunComplete();
      }
      await starting;
      await controller.onReplyStart();
      await controller.startTypingLoop();
      await controller.startTypingOnText("late text");
      controller.refreshTypingTtl();
      controller.markRunComplete();
      controller.markDispatchIdle();
      controller.cleanup();

      expect(controller.isActive()).toBe(false);
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("should prevent typing restart even if cleanup is delayed", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete (but dispatch not idle yet - simulating cleanup delay)
    controller.markRunComplete();

    // Multiple typing intervals should NOT restart typing
    vi.advanceTimersByTime(6000); // First interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Second interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Third interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an inert controller when typing callbacks are absent", async () => {
    const inert = createTypingController({});

    await inert.onReplyStart();
    await inert.startTypingLoop();
    await inert.startTypingOnText("hello");
    inert.refreshTypingTtl();
    inert.markRunComplete();
    inert.markDispatchIdle();
    inert.cleanup();

    expect(inert.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the explicit zero TTL disable sentinel", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const unboundedController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 121,
      typingTtlMs: 0,
      log: vi.fn(),
    });

    await unboundedController.startTypingLoop();
    unboundedController.refreshTypingTtl();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    unboundedController.cleanup();
  });

  it("clamps an oversized typing interval and derives a longer TTL", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const boundedController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: Number.MAX_SAFE_INTEGER,
      log: vi.fn(),
    });

    await boundedController.startTypingLoop();

    const maxTypingIntervalMs = Math.floor(MAX_TIMER_TIMEOUT_MS / 2);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs * 2);
    boundedController.cleanup();
  });
});
