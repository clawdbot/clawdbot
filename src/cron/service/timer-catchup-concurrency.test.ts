import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { run as runCronJob } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import { runMissedJobs } from "./timer.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-catchup-concurrency-" });

describe("cron startup catch-up concurrency", () => {
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
