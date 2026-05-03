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

function createIssue66019Job(params: { id: string; scheduledAt: number }) {
  return createIsolatedRegressionJob({
    id: params.id,
    name: params.id,
    scheduledAt: params.scheduledAt,
    schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
    payload: { kind: "agentTurn", message: "ping" },
    state: { nextRunAtMs: params.scheduledAt - 1_000 },
  });
}

function createIssue66019State(params: {
  storePath: string;
  nowMs: () => number;
  runIsolatedAgentJob: Parameters<typeof createCronServiceState>[0]["runIsolatedAgentJob"];
}) {
  return createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: noopLogger,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
  });
}

function clearCronTimer(state: ReturnType<typeof createCronServiceState>) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function expectJobDoesNotRefireWhenNextRunIsUnresolved(params: {
  state: ReturnType<typeof createCronServiceState>;
  runIsolatedAgentJob: unknown;
  advanceNow: () => void;
}) {
  await onTimer(params.state);
  expect(params.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  expect(params.state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();

  params.advanceNow();
  await onTimer(params.state);

  expect(params.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  expect(params.state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
}

describe("#66019 unresolved next-run repro", () => {
  it("does not refire a recurring cron job 2s later when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:40:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-minimal-success",
      scheduledAt,
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const runIsolatedAgentJob = createDefaultIsolatedRunner();
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    try {
      // Before the fix, applyJobResult would synthesize endedAt + 2_000 here,
      // so a second tick a couple seconds later would refire the same job.
      await expectJobDoesNotRefireWhenNextRunIsUnresolved({
        state,
        runIsolatedAgentJob,
        advanceNow: () => {
          now = scheduledAt + 2_001;
        },
      });
    } finally {
      nextRunSpy.mockRestore();
      clearCronTimer(state);
    }
  });

  it("does not refire a recurring errored cron job after the first backoff window when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:45:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-minimal-error",
      scheduledAt,
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "synthetic failure",
    });
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    try {
      // Before the fix, the error branch would synthesize the first backoff
      // retry (30s), so the next tick after that window would rerun the job.
      await expectJobDoesNotRefireWhenNextRunIsUnresolved({
        state,
        runIsolatedAgentJob,
        advanceNow: () => {
          now = scheduledAt + 30_001;
        },
      });
    } finally {
      nextRunSpy.mockRestore();
      clearCronTimer(state);
    }
  });

  it("preserves the active error backoff floor when maintenance repair later finds a natural next run", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:50:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-error-backoff-floor",
      scheduledAt,
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
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
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
      clearCronTimer(state);
    }
  });
});
