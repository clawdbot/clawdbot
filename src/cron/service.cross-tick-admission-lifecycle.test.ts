// Cross-tick lifecycle regressions cover delayed capacity wakes and activation skips.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { stop } from "./service/ops-lifecycle.js";
import { run } from "./service/ops-run.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStoreModule from "./store.js";
import type { CronJob } from "./types.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-lifecycle-",
});

describe("cron service cross-tick admission lifecycle", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("gives a waiter-delayed partial-batch wake an independent Gateway root", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:09:00.000Z");
    const scheduledA = createDueIsolatedJob({
      id: "delayed-listener-scheduled-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const scheduledB = createDueIsolatedJob({
      id: "delayed-listener-scheduled-b",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const pending = createDueIsolatedJob({
      id: "delayed-listener-pending",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const directA = createDueIsolatedJob({
      id: "delayed-listener-direct-a",
      nowMs: t0,
      nextRunAtMs: t0 + 3_600_000,
    });
    const directB = createDueIsolatedJob({
      id: "delayed-listener-direct-b",
      nowMs: t0,
      nextRunAtMs: t0 + 3_600_000,
    });
    await cronStoreModule.saveCronStore(store.storePath, {
      version: 1,
      jobs: [scheduledA, scheduledB, pending, directA, directB],
    });

    const scheduledStarted = createDeferred();
    let scheduledStartCount = 0;
    const releaseScheduledA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseScheduledB = createDeferred<{ status: "ok"; summary: string }>();
    const directAStarted = createDeferred();
    const directBStarted = createDeferred();
    const releaseDirectA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseDirectB = createDeferred<{ status: "ok"; summary: string }>();
    let pendingStartCount = 0;
    const releasePending = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => t0,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        switch (job.id) {
          case scheduledA.id:
            scheduledStartCount += 1;
            if (scheduledStartCount === 2) {
              scheduledStarted.resolve();
            }
            return await releaseScheduledA.promise;
          case scheduledB.id:
            scheduledStartCount += 1;
            if (scheduledStartCount === 2) {
              scheduledStarted.resolve();
            }
            return await releaseScheduledB.promise;
          case directA.id:
            directAStarted.resolve();
            return await releaseDirectA.promise;
          case directB.id:
            directBStarted.resolve();
            return await releaseDirectB.promise;
          case pending.id:
            pendingStartCount += 1;
            return await releasePending.promise;
          default:
            throw new Error(`unexpected cron job ${job.id}`);
        }
      }),
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const timerRun = onTimer(state);
    let directRunA: Promise<unknown> | undefined;
    let directRunB: Promise<unknown> | undefined;
    try {
      await scheduledStarted.promise;
      directRunA = runWithGatewayIndependentRootWorkAdmission(() =>
        run(state, directA.id, "force"),
      );
      directRunB = runWithGatewayIndependentRootWorkAdmission(() =>
        run(state, directB.id, "force"),
      );
      await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(2));

      releaseScheduledA.resolve({ status: "ok", summary: "scheduled a" });
      releaseScheduledB.resolve({ status: "ok", summary: "scheduled b" });
      await Promise.all([directAStarted.promise, directBStarted.promise]);
      await timerRun;

      expect(state.runAdmission.capacityListener).toBeTypeOf("function");
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      releaseDirectA.resolve({ status: "ok", summary: "direct a" });
      await vi.waitFor(() => expect(pendingStartCount).toBe(1));
      await directRunA;
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      releaseDirectB.resolve({ status: "ok", summary: "direct b" });
      await directRunB;
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      releasePending.resolve({ status: "ok", summary: "pending" });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    } finally {
      releaseScheduledA.resolve({ status: "ok", summary: "scheduled a cleanup" });
      releaseScheduledB.resolve({ status: "ok", summary: "scheduled b cleanup" });
      releaseDirectA.resolve({ status: "ok", summary: "direct a cleanup" });
      releaseDirectB.resolve({ status: "ok", summary: "direct b cleanup" });
      releasePending.resolve({ status: "ok", summary: "pending cleanup" });
      await Promise.allSettled([
        timerRun,
        directRunA ?? Promise.resolve(),
        directRunB ?? Promise.resolve(),
      ]);
      stop(state);
    }
  });

  it("restores the timer root when an open partial-batch listener wakes from a direct run", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:09:30.000Z");
    const scheduledA = createDueIsolatedJob({
      id: "open-listener-scheduled-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const scheduledB = createDueIsolatedJob({
      id: "open-listener-scheduled-b",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const pending = createDueIsolatedJob({
      id: "open-listener-pending",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const direct = createDueIsolatedJob({
      id: "open-listener-direct",
      nowMs: t0,
      nextRunAtMs: t0 + 3_600_000,
    });
    await cronStoreModule.saveCronStore(store.storePath, {
      version: 1,
      jobs: [scheduledA, scheduledB, pending, direct],
    });

    let scheduledStartCount = 0;
    const scheduledStarted = createDeferred();
    const releaseScheduledA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseScheduledB = createDeferred<{ status: "ok"; summary: string }>();
    const directStarted = createDeferred();
    const releaseDirect = createDeferred<{ status: "ok"; summary: string }>();
    const pendingStarted = createDeferred();
    const directRootRetired = createDeferred();
    const subordinateResult = createDeferred<unknown>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => t0,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        switch (job.id) {
          case scheduledA.id:
            scheduledStartCount += 1;
            if (scheduledStartCount === 2) {
              scheduledStarted.resolve();
            }
            return await releaseScheduledA.promise;
          case scheduledB.id:
            scheduledStartCount += 1;
            if (scheduledStartCount === 2) {
              scheduledStarted.resolve();
            }
            return await releaseScheduledB.promise;
          case direct.id:
            directStarted.resolve();
            return await releaseDirect.promise;
          case pending.id:
            pendingStarted.resolve();
            await directRootRetired.promise;
            try {
              await enqueueCommandInLane("cron-open-listener-subordinate", async () => {});
              subordinateResult.resolve("accepted");
              return { status: "ok" as const, summary: "pending" };
            } catch (error) {
              subordinateResult.resolve(error);
              throw error;
            }
          default:
            throw new Error(`unexpected cron job ${job.id}`);
        }
      }),
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const timerRun = onTimer(state);
    let directRun: Promise<unknown> | undefined;
    try {
      await scheduledStarted.promise;
      directRun = runWithGatewayIndependentRootWorkAdmission(() => run(state, direct.id, "force"));
      await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(1));

      releaseScheduledA.resolve({ status: "ok", summary: "scheduled a" });
      await directStarted.promise;
      expect(state.runAdmission.capacityListener).toBeTypeOf("function");
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      releaseDirect.resolve({ status: "ok", summary: "direct" });
      await pendingStarted.promise;
      await directRun;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      directRootRetired.resolve();

      const result = await subordinateResult.promise;
      expect(result).not.toBeInstanceOf(GatewayDrainingError);
      expect(result).toBe("accepted");
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      directRootRetired.resolve();
      releaseScheduledA.resolve({ status: "ok", summary: "scheduled a cleanup" });
      releaseScheduledB.resolve({ status: "ok", summary: "scheduled b cleanup" });
      releaseDirect.resolve({ status: "ok", summary: "direct cleanup" });
      await Promise.allSettled([timerRun, directRun ?? Promise.resolve()]);
      stop(state);
    }
  });

  it("refills capacity immediately after a clean post-reservation skip", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:10:00.000Z");
    const skipped = createDueIsolatedJob({
      id: "post-reservation-skip",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const pending = createDueIsolatedJob({
      id: "post-reservation-pending",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    await cronStoreModule.saveCronStore(store.storePath, {
      version: 1,
      jobs: [skipped, pending],
    });

    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      expect(job.id).toBe(pending.id);
      return { status: "ok" as const, summary: "pending" };
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => t0,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1;

    const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
    let queuedReloads = 0;
    const loadSpy = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (storePath) => {
        const loaded = await realLoad(storePath);
        const skippedJob = loaded.store.jobs.find((job) => job.id === skipped.id);
        if (skippedJob?.state.queuedAtMs !== undefined) {
          queuedReloads += 1;
          if (queuedReloads === 2) {
            skippedJob.enabled = false;
            await cronStoreModule.saveCronStore(storePath, loaded.store);
          }
        }
        return loaded;
      });

    try {
      await onTimer(state);

      expect(queuedReloads).toBeGreaterThanOrEqual(2);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(state.runAdmission.capacityListener).toBeNull();
      expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      const persisted = await cronStoreModule.loadCronStore(store.storePath);
      expect(persisted.jobs.find((job) => job.id === skipped.id)?.enabled).toBe(false);
      expect(persisted.jobs.find((job) => job.id === pending.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      loadSpy.mockRestore();
      stop(state);
    }
  });
});
