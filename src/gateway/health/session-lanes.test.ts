import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferred } from "../../test-utils/deferred.js";
import {
  buildSessionLaneHealthSummary,
  SESSION_LANE_DEGRADED_AFTER_MS,
  SESSION_LANE_UNHEALTHY_AFTER_MS,
} from "./session-lanes.js";

describe("session lane health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    resetCommandQueueStateForTest();
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    vi.useRealTimers();
  });

  it("reports resident count, oldest age, and queued-age degradation", async () => {
    const gate = createDeferred();
    const lane = "session:agent:main:lane-health";
    const active = enqueueCommandInLane(lane, async () => {
      await gate.promise;
    });
    const queued = enqueueCommandInLane(lane, async () => undefined);

    expect(buildSessionLaneHealthSummary()).toMatchObject({
      status: "healthy",
      count: 1,
      activeCount: 1,
      queuedCount: 1,
      oldestAgeMs: 0,
      oldestQueuedAgeMs: 0,
    });

    vi.advanceTimersByTime(SESSION_LANE_DEGRADED_AFTER_MS);
    expect(buildSessionLaneHealthSummary()).toMatchObject({
      status: "degraded",
      oldestAgeMs: SESSION_LANE_DEGRADED_AFTER_MS,
      oldestQueuedAgeMs: SESSION_LANE_DEGRADED_AFTER_MS,
    });

    vi.advanceTimersByTime(SESSION_LANE_UNHEALTHY_AFTER_MS - SESSION_LANE_DEGRADED_AFTER_MS);
    expect(buildSessionLaneHealthSummary()).toMatchObject({
      status: "unhealthy",
      oldestQueuedAgeMs: SESSION_LANE_UNHEALTHY_AFTER_MS,
    });

    gate.resolve();
    await active;
    await queued;
    expect(buildSessionLaneHealthSummary()).toEqual({
      status: "healthy",
      count: 0,
      activeCount: 0,
      queuedCount: 0,
      idleCount: 0,
      oldestAgeMs: null,
      oldestQueuedAgeMs: null,
    });
  });
});
