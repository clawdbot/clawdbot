// Regression: upstream commit 7d1575b5df (#60310, 2026-04-04) introduced
// activeJobIds + markCronJobActive/clearCronJobActive but only wired the pair
// into runDueJob and executeJob. The manual-run path (cron.run() →
// prepareManualRun + finishPreparedManualRun in src/cron/service/ops.ts) was
// left without the mark/clear pair, so task-registry.maintenance.ts
// hasBackingSession (cron branch under isCronRuntimeAuthoritative()=true)
// returns false during manual-run executions and reconciles them as `lost`
// after TASK_RECONCILE_GRACE_MS (5 min).
//
// The merged commit 1fae716a04 (resolveDurableCronTaskRecovery) reconciles
// terminal status retroactively from cron run-log + store.lastRunStatus, but
// only after the run finishes. This test asserts the producer-side mark/clear
// pair so the transient `lost` marker plus `Background task lost` system
// message is suppressed for long manual runs (force-mode `agentTurn` runs can
// reach AGENT_TURN_SAFETY_TIMEOUT_MS = 60 min).
//
// Production hot-path: cron.run("<id>", "force") direct invocation, the same
// surface used by the `openclaw cron run` CLI / RPC and agent tools. No
// internal-API rerouting (e.g. deferAgentTurnJobs:false) — the test exercises
// the same `prepareManualRun` → `finishPreparedManualRun` chain that hits
// production callers.

import { beforeEach, describe, expect, it } from "vitest";
import { isCronJobActive, resetCronActiveJobsForTests } from "./active-jobs.js";
import { CronService } from "./service.js";
import {
  createDeferred,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-manual-run-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

type IsolatedRunResult = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof CronService>[0]["runIsolatedAgentJob"]>>
>;

describe("cron activeJobIds — manual-run mark/clear", () => {
  beforeEach(() => {
    resetCronActiveJobsForTests();
  });

  it("marks the job active during a manual run and clears it on success", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2025-12-13T17:00:00.000Z");
    const futureNext = now + 3_600_000;

    const jobs: CronJob[] = [
      {
        id: "manual-isolated-ok",
        name: "manual isolated ok",
        enabled: true,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now,
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hi" },
        delivery: { mode: "none" },
        state: {
          nextRunAtMs: futureNext,
        },
      },
    ];

    await writeCronStoreSnapshot({ storePath: store.storePath, jobs });

    const entered = createDeferred<void>();
    const release = createDeferred<IsolatedRunResult>();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => {
        entered.resolve();
        return await release.promise;
      },
    });

    try {
      await cron.start();

      const runPromise = cron.run("manual-isolated-ok", "force");
      await entered.promise;

      expect(isCronJobActive("manual-isolated-ok")).toBe(true);

      release.resolve({ status: "ok", summary: "ok" });
      await runPromise;

      expect(isCronJobActive("manual-isolated-ok")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("clears the active marker even when the inner agent run throws", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2025-12-13T17:00:00.000Z");
    const futureNext = now + 3_600_000;

    const jobs: CronJob[] = [
      {
        id: "manual-isolated-throw",
        name: "manual isolated throw",
        enabled: true,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now,
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hi" },
        delivery: { mode: "none" },
        state: {
          nextRunAtMs: futureNext,
        },
      },
    ];

    await writeCronStoreSnapshot({ storePath: store.storePath, jobs });

    const entered = createDeferred<void>();
    const release = createDeferred<IsolatedRunResult>();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => {
        entered.resolve();
        return await release.promise;
      },
    });

    try {
      await cron.start();

      const runPromise = cron.run("manual-isolated-throw", "force");
      await entered.promise;

      expect(isCronJobActive("manual-isolated-throw")).toBe(true);

      release.reject(new Error("synthetic inner failure"));
      await runPromise;

      expect(isCronJobActive("manual-isolated-throw")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
