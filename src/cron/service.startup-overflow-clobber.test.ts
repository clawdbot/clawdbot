import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { start } from "./service/ops-lifecycle.js";
import { status } from "./service/ops-read.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-overflow-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService startup catch-up repair scoping", () => {
  function createDateBoundaryEveryJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

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

  it("disables startup catch-up deferrals that exceed the Date range", async () => {
    const store = await makeStorePath();
    const now = MAX_DATE_TIMESTAMP_MS - 2_000;
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createDateBoundaryEveryJob("date-limit-0", now - 60_000),
        createDateBoundaryEveryJob("date-limit-1", now - 50_000),
        createDateBoundaryEveryJob("date-limit-2", now - 40_000),
      ],
    });
    const order: string[] = [];
    const deferredAutoDisableReasons = new Set([
      "cron:date-limit-1:auto-disabled",
      "cron:date-limit-2:auto-disabled",
    ]);
    const enqueueSystemEvent = vi.fn((_text: string, context?: { contextKey?: string }) => {
      if (context?.contextKey && deferredAutoDisableReasons.has(context.contextKey)) {
        if (!order.includes("persist")) {
          const rows = openOpenClawStateDatabase()
            .db.prepare(
              "SELECT job_id AS jobId, state_json AS stateJson FROM cron_jobs WHERE store_key = ? AND job_id IN (?, ?) ORDER BY job_id",
            )
            .all(cronStoreKey(store.storePath), "date-limit-1", "date-limit-2") as Array<{
            jobId: string;
            stateJson: string;
          }>;
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(JSON.parse(row.stateJson)).toMatchObject({
              autoDisabled: { reason: "schedule-errors" },
            });
          }
          order.push("persist");
        }
        order.push("notify");
      }
    });
    const requestHeartbeat = vi.fn(
      (request: { source?: string; intent?: string; reason?: string }) => {
        if (
          order.at(-1) === "notify" &&
          request.source === "notifications-event" &&
          request.intent === "immediate" &&
          request.reason === "wake"
        ) {
          order.push("heartbeat");
        }
      },
    );
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });
    try {
      await runMissedJobs(state);

      const deferred = (state.store?.jobs ?? []).filter((job) => job.id !== "date-limit-0");
      expect(deferred).toHaveLength(2);
      for (const job of deferred) {
        expect(job.enabled).toBe(false);
        expect(job.state.nextRunAtMs).toBeUndefined();
        expect(job.state.startupCatchupAtMs).toBeUndefined();
        expect(job.state.autoDisabled).toEqual({
          reason: "schedule-errors",
          atMs: now,
          consecutiveErrors: 1,
        });
      }
      expect(order).toEqual(["persist", "notify", "heartbeat", "notify", "heartbeat"]);
      expect((await loadCronStore(store.storePath)).jobs).toEqual(
        expect.arrayContaining(
          deferred.map((job) =>
            expect.objectContaining({
              id: job.id,
              enabled: false,
              state: expect.objectContaining({ autoDisabled: job.state.autoDisabled }),
            }),
          ),
        ),
      );
    } finally {
      await store.cleanup();
    }
  });
});
