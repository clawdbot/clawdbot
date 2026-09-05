// Integration regressions for cron-owned heartbeat watchdog handoffs.
import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const heartbeatWatchdogFixtures = setupCronRegressionFixtures({
  prefix: "cron-heartbeat-watchdog-",
});

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

describe("cron heartbeat watchdog", () => {
  it.each([
    {
      name: "monitor",
      payload: { kind: "heartbeat" } as const,
      wakeMode: "next-heartbeat" as const,
    },
    {
      name: "main system event",
      payload: { kind: "systemEvent", text: "check heartbeat work" } as const,
      wakeMode: "now" as const,
    },
  ])(
    "disables the outer watchdog for an unlimited $name heartbeat",
    async ({ payload, wakeMode }) => {
      vi.useFakeTimers();
      try {
        const store = heartbeatWatchdogFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-09-02T12:20:00.000Z");
        const cronJob = createIsolatedRegressionJob({
          id: `unlimited-${payload.kind}`,
          name: `unlimited ${payload.kind}`,
          scheduledAt,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
          payload,
          state: { nextRunAtMs: scheduledAt },
        });
        cronJob.sessionTarget = "main";
        cronJob.wakeMode = wakeMode;
        await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

        vi.setSystemTime(scheduledAt);
        const heartbeatStarted = createDeferred();
        const releaseHeartbeat = createDeferred();
        const runHeartbeat = async () => {
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
          return { status: "ran" as const, durationMs: 1 };
        };
        const state = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => Date.now(),
          defaultAgentId: "main",
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          resolveHeartbeatTimeoutMs: vi.fn(() => undefined),
          requestHeartbeatAndWait:
            vi.fn<NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>>(runHeartbeat),
          runHeartbeatOnce: vi.fn<NonNullable<CronServiceDeps["runHeartbeatOnce"]>>(runHeartbeat),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        const timerPromise = onTimer(state);
        let timerSettled = false;
        void timerPromise.then(() => {
          timerSettled = true;
        });
        await heartbeatStarted.promise;

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(timerSettled).toBe(false);

        releaseHeartbeat.resolve();
        await timerPromise;
        expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps the cron deadline while a heartbeat-backed trigger is still evaluating", async () => {
    vi.useFakeTimers();
    try {
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-09-02T12:30:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "heartbeat-trigger-watchdog",
        name: "heartbeat trigger watchdog",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
        payload: { kind: "systemEvent", text: "check heartbeat work" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      cronJob.wakeMode = "now";
      cronJob.trigger = { script: "return { fire: true };" };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      const triggerStarted = createDeferred();
      const resolveHeartbeatTimeoutMs = vi.fn(() => 15 * 60_000);
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runHeartbeatOnce: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
        resolveHeartbeatTimeoutMs,
        evaluateCronTrigger: vi.fn(async () => {
          triggerStarted.resolve();
          return await new Promise<never>(() => {});
        }),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const timerPromise = onTimer(state);
      await triggerStarted.promise;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await timerPromise;

      expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
      expect(state.deps.runHeartbeatOnce).not.toHaveBeenCalled();
      expect(requireJob(state, cronJob.id).state.lastError).toContain("job execution timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
