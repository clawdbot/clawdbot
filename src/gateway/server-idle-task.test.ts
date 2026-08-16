import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleGatewayIdleTask", () => {
  it("still completes ordinary idle work", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    handle.stop();
  });
});
