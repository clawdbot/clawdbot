import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { add, update } from "./ops-mutations.js";
import { run as runCronJob } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer-scheduler.js";
import { runMissedJobs } from "./timer.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-catchup-concurrency-" });

describe("cron startup catch-up concurrency", () => {
  it.each(["display", "payload", "schedule", "cron-history", "reactivated", "timer"] as const)(
    "preserves catch-up pacing across declarative %s reconciliation",
    async (change) => {
      const { storePath } = fixtures.makeStorePath();
      let now = Date.parse("2025-12-13T17:00:00.000Z");
      const selected = createDueIsolatedJob({
        id: "selected",
        nowMs: now,
        nextRunAtMs: now - 60_000,
      });
      const deferred = createDueIsolatedJob({
        id: "deferred",
        nowMs: now,
        nextRunAtMs: now - 50_000,
      });
      deferred.declarationKey = "daily-check";
      deferred.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 110_000 };
      if (change === "cron-history" || change === "reactivated") {
        deferred.schedule = { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 };
        deferred.state.lastRunAtMs = now - 120_000;
        deferred.state.lastRunStatus = "ok";
        if (change === "reactivated") {
          deferred.state.nextRunAtMs = now + 60_000;
        }
      }
      await saveCronStore(storePath, { version: 1, jobs: [selected, deferred] });
      const started = createDeferred();
      const release = createDeferred();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        maxMissedJobsPerRestart: 1,
        missedJobStaggerMs: 5_000,
        runIsolatedAgentJob: vi.fn(async ({ job }) => {
          if (job.id === selected.id) {
            started.resolve();
            await release.promise;
          }
          return { status: "ok" as const };
        }),
      });
      const catchup = runMissedJobs(state);
      try {
        await started.promise;
        let reconciled = await add(state, {
          ...deferred,
          displayName: change === "display" ? "New label" : undefined,
          payload:
            change === "payload" ? { kind: "agentTurn", message: "New task" } : deferred.payload,
          schedule: change === "schedule" ? { kind: "every", everyMs: 120_000 } : deferred.schedule,
        });
        if (change === "reactivated") {
          // The same future slot can belong to a newly enabled schedule; the
          // missed occurrence retired by this edit must not regain catch-up.
          now += 1;
          await update(state, deferred.id, { enabled: false });
          now += 1;
          reconciled = await update(state, deferred.id, { enabled: true });
          expect(reconciled.state.nextRunAtMs).toBe(deferred.state.nextRunAtMs);
          expect(reconciled.state.scheduleActivatedAtMs).toBe(now);
        }
        if (change === "timer") {
          now += 2_000;
          await onTimer(state);
          expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          now += 6_000;
          await onTimer(state);
          expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        }
        release.resolve();
        await catchup;
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (job) => job.id === deferred.id,
        );
        const replacedSchedule = change === "schedule" || change === "reactivated";
        const expected = replacedSchedule ? reconciled.state.nextRunAtMs : now + 5_000;
        expect(persisted?.state.nextRunAtMs).toBe(expected);
        expect(persisted?.state.startupCatchupAtMs).toBe(replacedSchedule ? undefined : expected);
        // A fresh scheduler must see the durable pacing fact, not replay the old due slot.
        const restarted = createCronServiceState(state.deps);
        await runMissedJobs(restarted);
        expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await catchup;
      }
    },
  );

  it("does not defer a recurring job completed by another gateway during catch-up", async () => {
    const store = fixtures.makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const selected = createDueIsolatedJob({
      id: "foreign-window-selected",
      nowMs: startNow,
      nextRunAtMs: startNow - 60_000,
    });
    const deferred = createDueIsolatedJob({
      id: "foreign-window-deferred",
      nowMs: startNow,
      nextRunAtMs: startNow - 50_000,
    });
    selected.schedule = { kind: "every", everyMs: 60_000, anchorMs: startNow - 120_000 };
    deferred.schedule = { kind: "every", everyMs: 60_000, anchorMs: startNow - 110_000 };
    await saveCronStore(store.storePath, { version: 1, jobs: [selected, deferred] });
    const selectedStarted = createDeferred();
    const releaseSelected = createDeferred<{ status: "ok"; summary: string }>();
    const firstState = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
      runIsolatedAgentJob: vi.fn(async ({ job }) => {
        if (job.id === selected.id) {
          selectedStarted.resolve();
          return await releaseSelected.promise;
        }
        return { status: "ok" as const, summary: "unexpected" };
      }),
    });
    const catchup = runMissedJobs(firstState);

    try {
      await selectedStarted.promise;
      const foreignNow = startNow + 1;
      const foreignState = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => foreignNow,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "foreign" })),
      });
      await expect(runCronJob(foreignState, deferred.id, "force")).resolves.toEqual({
        ok: true,
        ran: true,
      });
      const foreignCompleted = (await loadCronStore(store.storePath)).jobs.find(
        (job) => job.id === deferred.id,
      );

      releaseSelected.resolve({ status: "ok", summary: "selected" });
      await catchup;

      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (job) => job.id === deferred.id,
      );
      expect(persisted?.state.lastRunAtMs).toBe(foreignNow);
      expect(persisted?.state.nextRunAtMs).toBe(foreignCompleted?.state.nextRunAtMs);
      expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
    } finally {
      releaseSelected.resolve({ status: "ok", summary: "selected" });
      await catchup;
    }
  });
});
