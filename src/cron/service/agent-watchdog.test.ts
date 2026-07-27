import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";

describe("cron agent setup watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not keep lane-wait suppression after lane admission", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();
    watchdog.noteLaneWait();
    watchdog.noteLaneAdmitted();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("starts setup timeout only after lane admission", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();
    watchdog.noteLaneWait();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).not.toHaveBeenCalled();
    expect(watchdog.observedLaneWait()).toBe(true);

    watchdog.noteLaneAdmitted();

    expect(triggerTimeout).not.toHaveBeenCalled();
    expect(watchdog.observedLaneWait()).toBe(false);

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("restarts the complete setup budget after repeated lane contention", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      watchdog.noteLaneWait();
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS * 2);
      expect(triggerTimeout).not.toHaveBeenCalled();
      watchdog.noteLaneAdmitted();
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
      expect(triggerTimeout).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });
});
