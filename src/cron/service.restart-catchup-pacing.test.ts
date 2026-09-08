import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";

const FIRST_RUN_AT = Date.parse("2026-09-06T12:00:00.000Z");
const MINUTE = 60_000;
const PACED_DELAY = 30 * MINUTE;
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-paced-restart-",
  baseTimeIso: new Date(FIRST_RUN_AT - MINUTE).toISOString(),
});

type RestartCase = {
  label: string;
  scheduleKind: "cron" | "every";
  paced: boolean;
  restartAfterMs: number;
  expectedNextAfterMs: number;
  forceStatus?: "ok" | "error";
  firstStatus?: "error";
};

describe("CronService restart catch-up with dynamic cadence", () => {
  it.each<RestartCase>([
    {
      label: "a future paced cron deadline",
      scheduleKind: "cron",
      paced: true,
      restartAfterMs: 10 * MINUTE,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "a future paced every deadline",
      scheduleKind: "every",
      paced: true,
      restartAfterMs: 10 * MINUTE,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "a paced cron deadline after a successful force run",
      scheduleKind: "cron",
      paced: true,
      forceStatus: "ok",
      restartAfterMs: 10 * MINUTE + 1_000,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "a paced cron deadline during a failed force run's backoff",
      scheduleKind: "cron",
      paced: true,
      forceStatus: "error",
      restartAfterMs: 10 * MINUTE + 1_000,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "a paced every deadline during a failed force run's backoff",
      scheduleKind: "every",
      paced: true,
      forceStatus: "error",
      restartAfterMs: 10 * MINUTE + 1_000,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "catch-up for an overdue paced cron deadline",
      scheduleKind: "cron",
      paced: true,
      restartAfterMs: 31 * MINUTE,
      expectedNextAfterMs: 33 * MINUTE,
    },
    {
      label: "catch-up for an overdue paced every deadline",
      scheduleKind: "every",
      paced: true,
      restartAfterMs: 31 * MINUTE,
      expectedNextAfterMs: 33 * MINUTE,
    },
    {
      label: "catch-up for an unpaced cron deadline",
      scheduleKind: "cron",
      paced: false,
      restartAfterMs: 10 * MINUTE,
      expectedNextAfterMs: 12 * MINUTE,
    },
    {
      label: "backoff after a failed scheduled cron run",
      scheduleKind: "cron",
      paced: false,
      firstStatus: "error",
      restartAfterMs: 10_000,
      expectedNextAfterMs: 30_000,
    },
  ])("preserves $label", async (scenario) => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>();
    runIsolatedAgentJob.mockResolvedValue({ status: "ok" });
    runIsolatedAgentJob.mockResolvedValueOnce(
      scenario.firstStatus === "error"
        ? { status: "error", error: "temporary timeout" }
        : {
            status: "ok",
            ...(scenario.paced ? { nextCheck: { delayMs: PACED_DELAY } } : {}),
          },
    );
    const createService = () =>
      new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
    const original = createService();
    const restarted = createService();

    try {
      await original.start();
      const job = await original.add({
        enabled: true,
        name: "paced reminder",
        schedule:
          scenario.scheduleKind === "cron"
            ? { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 }
            : { kind: "every", everyMs: MINUTE },
        ...(scenario.paced ? { pacing: { min: "15m", max: "4h" } } : {}),
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the reminder" },
        delivery: { mode: "none" },
      });
      expect(job.state.nextRunAtMs).toBe(FIRST_RUN_AT);
      vi.setSystemTime(FIRST_RUN_AT);
      await expect(original.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      if (scenario.forceStatus) {
        vi.setSystemTime(FIRST_RUN_AT + 10 * MINUTE - 1_000);
        runIsolatedAgentJob.mockResolvedValueOnce({
          status: scenario.forceStatus,
          ...(scenario.forceStatus === "error" ? { error: "temporary timeout" } : {}),
        });
        await expect(original.run(job.id, "force")).resolves.toMatchObject({ ok: true, ran: true });
      }
      original.stop();

      const before = (await loadCronStore(store.storePath)).jobs[0];
      const initialNextAfterMs = scenario.firstStatus
        ? 30_000
        : scenario.paced
          ? PACED_DELAY
          : MINUTE;
      expect(before?.state.nextRunAtMs).toBe(FIRST_RUN_AT + initialNextAfterMs);
      expect(before?.state.pacedNextRunAtMs).toBe(
        scenario.paced ? FIRST_RUN_AT + PACED_DELAY : undefined,
      );
      const completedRuns = scenario.forceStatus ? 2 : 1;
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns);

      vi.setSystemTime(FIRST_RUN_AT + scenario.restartAfterMs);
      await restarted.start();
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns);
      const after = (await loadCronStore(store.storePath)).jobs[0];
      const expectedNextRunAtMs = FIRST_RUN_AT + scenario.expectedNextAfterMs;
      expect(after?.state.nextRunAtMs).toBe(expectedNextRunAtMs);
      expect(after?.state.lastRunAtMs).toBe(before?.state.lastRunAtMs);
      expect(after?.state.pacedNextRunAtMs).toBe(
        scenario.paced && scenario.restartAfterMs < PACED_DELAY
          ? FIRST_RUN_AT + PACED_DELAY
          : undefined,
      );

      vi.setSystemTime(expectedNextRunAtMs);
      await expect(restarted.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns + 1);
    } finally {
      original.stop();
      restarted.stop();
      await store.cleanup();
    }
  });
});
