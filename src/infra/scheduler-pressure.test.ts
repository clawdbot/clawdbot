import { afterEach, describe, expect, it, vi } from "vitest";
import { getSchedulerPressureSnapshot, testing } from "./scheduler-pressure.js";

describe("scheduler pressure", () => {
  afterEach(() => {
    testing.reset();
    vi.useRealTimers();
  });

  it("holds event-loop pressure through a cooldown before recovering", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    testing.recordDiagnosticEvent(
      {
        type: "diagnostic.liveness.warning",
        seq: 1,
        ts: 1_000,
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 750,
        active: 1,
        waiting: 0,
        queued: 1,
      },
      1_000,
    );

    expect(getSchedulerPressureSnapshot()).toMatchObject({
      pressured: true,
      eventLoopDelayP99Ms: 750,
      pressureUntil: 121_000,
    });

    vi.advanceTimersByTime(120_000);
    expect(getSchedulerPressureSnapshot()).toMatchObject({
      pressured: false,
      eventLoopDelayP99Ms: 750,
    });
  });

  it("records recent RSS pressure and memory usage", () => {
    testing.recordDiagnosticEvent(
      {
        type: "diagnostic.memory.pressure",
        seq: 1,
        ts: Date.now(),
        level: "warning",
        reason: "rss_threshold",
        memory: {
          rssBytes: 3_000,
          heapUsedBytes: 1_000,
          heapTotalBytes: 2_000,
          externalBytes: 0,
          arrayBuffersBytes: 0,
        },
      },
      Date.now(),
    );

    expect(getSchedulerPressureSnapshot()).toMatchObject({
      pressured: true,
      rssBytes: 3_000,
      memoryPressure: {
        level: "warning",
        reason: "rss_threshold",
      },
    });
  });
});