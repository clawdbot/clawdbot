// Restart catch-up must not resurrect slots that predate a schedule edit.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2026-07-28T07:18:00.000Z",
});

describe("CronService restart catch-up after a schedule change", () => {
  it("does not replay a cron slot that predates the new schedule", async () => {
    // Real report (#91944): a daily 19:00 job edited to 21:00 at 10:18 fired
    // immediately when the gateway restarted at 13:18. Yesterday's 21:00 slot
    // never existed under the old schedule, so it is not a missed run.
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const jobId = "restart-pre-activation-slot";
    const lastRunUnderOldSchedule = Date.parse("2026-07-27T16:00:00.000Z"); // 27 Jul 19:00 +03
    const createService = () =>
      new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runCommandJob: runCommandJob as never,
      });

    vi.setSystemTime(new Date("2026-07-28T07:18:00.000Z")); // 10:18 Europe/Istanbul
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: jobId,
          name: "daily briefing",
          enabled: true,
          createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
          updatedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
          schedule: { kind: "cron", expr: "0 19 * * *", tz: "Europe/Istanbul" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: {
            nextRunAtMs: Date.parse("2026-07-28T16:00:00.000Z"), // 28 Jul 19:00 +03
            lastRunAtMs: lastRunUnderOldSchedule,
            lastStatus: "ok",
          },
        },
      ],
    });

    const editor = createService();
    try {
      await editor.start();
      await editor.update(jobId, {
        schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Istanbul" },
      });
      const activatedAtMs = Date.parse("2026-07-28T07:18:00.000Z");
      expect(editor.getJob(jobId)?.state.scheduleActivatedAtMs).toBe(activatedAtMs);

      vi.setSystemTime(new Date("2026-07-28T08:18:00.000Z"));
      await editor.update(jobId, { name: "renamed daily briefing" });
      await editor.update(jobId, {
        schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Istanbul" },
      });
      const idempotentlyUpdated = editor.getJob(jobId);
      expect(idempotentlyUpdated?.state.scheduleActivatedAtMs).toBe(activatedAtMs);
      expect(idempotentlyUpdated?.updatedAtMs).toBe(Date.parse("2026-07-28T08:18:00.000Z"));
    } finally {
      editor.stop();
    }
    // The edit itself is not a run; catch-up must stay quiet before the restart.
    expect(runCommandJob).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-28T10:18:00.000Z")); // 13:18 Europe/Istanbul
    const restarted = createService();
    try {
      await restarted.start();

      expect(runCommandJob).not.toHaveBeenCalled();
      const job = (await restarted.list({ includeDisabled: true })).find(
        (entry) => entry.id === jobId,
      );
      expect(job?.state.lastRunAtMs).toBe(lastRunUnderOldSchedule);
      expect(job?.state.nextRunAtMs).toBe(Date.parse("2026-07-28T18:00:00.000Z"));
    } finally {
      restarted.stop();
      await store.cleanup();
    }
  });

  it("runs a genuine missed slot that occurred after schedule activation", async () => {
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const now = Date.parse("2026-07-30T13:18:00.000Z");
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "restart-post-activation-slot",
          name: "daily briefing",
          enabled: true,
          createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
          updatedAtMs: Date.parse("2026-07-29T08:00:00.000Z"),
          schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: {
            nextRunAtMs: Date.parse("2026-07-31T12:00:00.000Z"),
            lastRunAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
            lastStatus: "ok",
            scheduleActivatedAtMs: Date.parse("2026-07-29T08:00:00.000Z"),
          },
        },
      ],
    });
    const service = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: runCommandJob as never,
    });

    try {
      await service.start();

      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(service.getJob("restart-post-activation-slot")?.state.lastRunAtMs).toBe(now);
    } finally {
      service.stop();
      await store.cleanup();
    }
  });

  it("preserves one legacy catch-up for an unstamped pre-upgrade job", async () => {
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const now = Date.parse("2026-07-30T13:18:00.000Z");
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "restart-legacy-unstamped-slot",
          name: "legacy daily briefing",
          enabled: true,
          createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
          updatedAtMs: Date.parse("2026-07-29T08:00:00.000Z"),
          schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: {
            nextRunAtMs: Date.parse("2026-07-31T12:00:00.000Z"),
            lastRunAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
    });
    const createService = () =>
      new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runCommandJob: runCommandJob as never,
      });

    const firstRestart = createService();
    try {
      await firstRestart.start();
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(firstRestart.getJob("restart-legacy-unstamped-slot")?.state.lastRunAtMs).toBe(now);
    } finally {
      firstRestart.stop();
    }

    const secondRestart = createService();
    try {
      await secondRestart.start();
      expect(runCommandJob).toHaveBeenCalledTimes(1);
    } finally {
      secondRestart.stop();
      await store.cleanup();
    }
  });
});
