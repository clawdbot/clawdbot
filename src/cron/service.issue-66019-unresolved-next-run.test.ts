import { describe, expect, it, vi } from "vitest";
import {
  createDefaultIsolatedRunner,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import * as schedule from "./schedule.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";

const issue66019Fixtures = setupCronRegressionFixtures({ prefix: "cron-66019-" });

describe("#66019 unresolved next-run repro", () => {
  it("does not refire a recurring cron job 2s later when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:40:00.000Z");
    let now = scheduledAt;

    const cronJob = createIsolatedRegressionJob({
      id: "cron-66019-minimal-success",
      name: "cron-66019-minimal-success",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: scheduledAt - 1_000 },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const runIsolatedAgentJob = createDefaultIsolatedRunner();
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();

      // Before the fix, applyJobResult would synthesize endedAt + 2_000 here,
      // so a second tick a couple seconds later would refire the same job.
      now = scheduledAt + 2_001;
      await onTimer(state);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    } finally {
      nextRunSpy.mockRestore();
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
  });

  it("does not refire a recurring errored cron job after the first backoff window when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:45:00.000Z");
    let now = scheduledAt;

    const cronJob = createIsolatedRegressionJob({
      id: "cron-66019-minimal-error",
      name: "cron-66019-minimal-error",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: scheduledAt - 1_000 },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "synthetic failure",
    });
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();

      // Before the fix, the error branch would synthesize the first backoff
      // retry (30s), so the next tick after that window would rerun the job.
      now = scheduledAt + 30_001;
      await onTimer(state);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    } finally {
      nextRunSpy.mockRestore();
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
  });

  it("preserves the active error backoff floor when maintenance repair later finds a natural next run", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:50:00.000Z");
    let now = scheduledAt;

    const cronJob = createIsolatedRegressionJob({
      id: "cron-66019-error-backoff-floor",
      name: "cron-66019-error-backoff-floor",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: scheduledAt - 1_000 },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "synthetic failure",
    });
    const naturalNext = scheduledAt + 5_000;
    const backoffNext = scheduledAt + 30_000;
    const nextRunSpy = vi
      .spyOn(schedule, "computeNextRunAtMs")
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(naturalNext);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(backoffNext);

      now = naturalNext + 1;
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      now = backoffNext + 1;
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    } finally {
      nextRunSpy.mockRestore();
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
  });
});
