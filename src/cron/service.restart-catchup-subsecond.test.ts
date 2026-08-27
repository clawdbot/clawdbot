// Restart catch-up must include a missed cron slot throughout its first second.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-subsecond-",
  baseTimeIso: "2025-12-13T04:02:00.500Z",
});

describe("CronService restart catch-up within a cron slot's first second", () => {
  it("replays the missed slot when the persisted next run already advanced", async () => {
    const restartAtMs = Date.parse("2025-12-13T04:02:00.500Z");
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "restart-missed-subsecond-slot",
          name: "every minute",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:03:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: runCommandJob as never,
    });

    try {
      await cron.start();
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(cron.getJob("restart-missed-subsecond-slot")?.state.lastRunAtMs).toBe(restartAtMs);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it.each([
    {
      label: "the first daylight-saving fold after restarting in the repeated hour",
      id: "restart-missed-first-daylight-saving-fold",
      restartAt: "2026-11-01T06:05:00.000Z",
      expression: "30 1,3 * * *",
      lastRunAt: "2026-10-31T07:30:00.000Z",
      nextRunAt: "2026-11-01T08:30:00.000Z",
    },
    {
      label: "the last valid reminder after restarting beyond a spring-forward gap",
      id: "restart-missed-before-daylight-saving-gap",
      restartAt: "2027-03-14T07:05:00.000Z",
      expression: "45 1,2,3 * * *",
      lastRunAt: "2027-03-13T08:45:00.000Z",
      nextRunAt: "2027-03-14T07:45:00.000Z",
    },
  ])("replays $label", async ({ id, restartAt, expression, lastRunAt, nextRunAt }) => {
    const restartAtMs = Date.parse(restartAt);
    const lastRunAtMs = Date.parse(lastRunAt);
    const nextRunAtMs = Date.parse(nextRunAt);
    vi.setSystemTime(new Date(restartAtMs));
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id,
          name: id,
          enabled: true,
          createdAtMs: lastRunAtMs,
          updatedAtMs: lastRunAtMs,
          schedule: { kind: "cron", expr: expression, tz: "America/New_York" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: {
            nextRunAtMs,
            lastRunAtMs,
            lastStatus: "ok",
          },
        },
      ],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: runCommandJob as never,
    });

    try {
      await cron.start();
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(cron.getJob(id)?.state).toMatchObject({
        lastRunAtMs: restartAtMs,
        nextRunAtMs,
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
