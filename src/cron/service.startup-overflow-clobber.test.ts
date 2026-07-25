import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { start, status } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-overflow-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService startup catch-up repair scoping", () => {
  function createHourlyCronJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  function createDailyCronJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  it("keeps the overflow daily-cron catch-up deferral across a second restart", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;
    const tomorrowNaturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createHourlyCronJob("hourly-0", Date.parse("2025-12-13T03:00:00.000Z")),
        createHourlyCronJob("hourly-1", Date.parse("2025-12-13T04:00:00.000Z")),
        createHourlyCronJob("hourly-2", Date.parse("2025-12-13T05:00:00.000Z")),
        createHourlyCronJob("hourly-3", Date.parse("2025-12-13T06:00:00.000Z")),
        createHourlyCronJob("hourly-4", Date.parse("2025-12-13T07:00:00.000Z")),
        createDailyCronJob("daily-overflow", Date.parse("2025-12-13T09:00:00.000Z")),
      ],
    });

    const createState = () =>
      createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
    const state = createState();

    await start(state);

    const deferred = state.store?.jobs.find((job) => job.id === "daily-overflow");

    expect(deferred?.state.nextRunAtMs).toBe(startNow + 5_000);
    expect(deferred?.state.nextRunAtMs).not.toBe(tomorrowNaturalSlot);
    expect(deferred?.state.startupCatchupAtMs).toBe(startNow + 5_000);

    await status(state);
    expect(deferred?.state.nextRunAtMs).toBe(startNow + 5_000);

    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.stopped = true;
    now = startNow + 3_000;

    const restartedState = createState();
    await start(restartedState);

    const restarted = restartedState.store?.jobs.find((job) => job.id === "daily-overflow");
    expect(restarted?.state.nextRunAtMs).toBe(startNow + 5_000);
    expect(restarted?.state.startupCatchupAtMs).toBe(startNow + 5_000);

    now = startNow + 5_005;
    await onTimer(restartedState);

    const completed = restartedState.store?.jobs.find((job) => job.id === "daily-overflow");
    expect(completed?.state.lastRunStatus).toBe("ok");
    expect(completed?.state.nextRunAtMs).toBe(tomorrowNaturalSlot);
    expect(completed?.state.startupCatchupAtMs).toBeUndefined();

    if (restartedState.timer) {
      clearTimeout(restartedState.timer);
    }
    restartedState.stopped = true;
    await store.cleanup();
  });

  it("still repairs a stale future cron slot on start() when no jobs were deferred", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const staleFutureSlot = Date.parse("2025-12-13T18:00:00.000Z");
    const naturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDailyCronJob("daily-stale-future", staleFutureSlot)],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    const repaired = state.store?.jobs.find((job) => job.id === "daily-stale-future");

    expect(repaired?.state.nextRunAtMs).toBe(naturalSlot);
    expect(repaired?.state.nextRunAtMs).not.toBe(staleFutureSlot);

    state.stopped = true;
    await store.cleanup();
  });
});
