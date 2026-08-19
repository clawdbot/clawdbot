import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { getQueueState } from "../../process/command-queue.state.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { buildSessionLaneHealthSummary } from "./session-lanes.js";

const SESSION_LANE_DEGRADED_AFTER_MS = 15 * 60_000;
const SESSION_LANE_UNHEALTHY_AFTER_MS = 60 * 60_000;

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

  it("keeps resident lane age unknown when inherited hot-reload state has no timestamp", async () => {
    const gate = createDeferred();
    const lane = "session:agent:main:legacy-hot-reload";
    const active = enqueueCommandInLane(lane, async () => {
      await gate.promise;
    });
    const state = getQueueState().lanes.get(lane);
    expect(state).toBeDefined();
    delete state?.createdAtMs;

    vi.advanceTimersByTime(SESSION_LANE_UNHEALTHY_AFTER_MS);
    expect(buildSessionLaneHealthSummary()).toMatchObject({
      status: "healthy",
      count: 1,
      activeCount: 1,
      oldestAgeMs: null,
      oldestQueuedAgeMs: null,
    });

    gate.resolve();
    await active;
  });
});
