import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

afterEach(() => {
  resetGatewayWorkAdmission();
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

  it("quietly cancels idle work rejected by an active restart drain", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn },
      errorMessage: "idle task failed",
    });

    markGatewayRestartDraining();
    await vi.advanceTimersByTimeAsync(10);

    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    handle.stop();
  });

  it("warns when idle work throws a draining error without an active restart", async () => {
    vi.useFakeTimers();
    const error = new GatewayDrainingError("unexpected task failure");
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run: async () => {
        throw error;
      },
      log: { warn },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(warn).toHaveBeenCalledWith(`idle task failed: ${String(error)}`);
    handle.stop();
  });
});
