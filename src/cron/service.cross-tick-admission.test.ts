// Scheduled work must use free shared-admission slots across timer ticks (#119083).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import { stop } from "./service/ops-lifecycle.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.js";
import type { CronJob } from "./types.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-admission-",
});

describe("cron service cross-tick bounded admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a later-due job while an earlier receipt-backed run is still active", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    const jobA = createDueIsolatedJob({
      id: "cross-tick-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobB = createDueIsolatedJob({
      id: "cross-tick-b",
      nowMs: t0,
      nextRunAtMs: t0 + 60_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB] });

    let now = t0;
    let active = 0;
    let peakActive = 0;
    const aStarted = createDeferred<void>();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const bStarted = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        if (job.id === jobA.id) {
          aStarted.resolve();
          return await releaseA.promise;
        }
        bStarted.resolve();
        return { status: "ok" as const, summary: "b done" };
      } finally {
        active -= 1;
      }
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const tickA = onTimer(state);
    try {
      await aStarted.promise;
      now = t0 + 60_000;
      await onTimer(state);

      await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2), {
        timeout: 500,
      });
      await bStarted.promise;
      expect(peakActive).toBe(2);
    } finally {
      releaseA.resolve({ status: "ok", summary: "a done" });
      await tickA;
    }

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.every((job) => job.state.queuedAtMs === undefined)).toBe(true);
    expect(persisted.jobs.every((job) => job.state.runningAtMs === undefined)).toBe(true);
    expect(persisted.jobs.every((job) => job.state.lastRunStatus === "ok")).toBe(true);
    expect(state.activeTimerTicks).toBe(0);
    expect(state.running).toBe(false);
    stop(state);
  });

  it("does not create receipts or retain timer batches while all slots are full", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:06:00.000Z");
    const jobA = createDueIsolatedJob({
      id: "saturated-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobB = createDueIsolatedJob({
      id: "saturated-b",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobC = createDueIsolatedJob({
      id: "saturated-later",
      nowMs: t0,
      nextRunAtMs: t0 + 60_000,
    });
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [jobA, jobB, jobC],
    });

    let now = t0;
    let active = 0;
    let peakActive = 0;
    const bothStarted = createDeferred<void>();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseB = createDeferred<{ status: "ok"; summary: string }>();
    const cStarted = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (active === 2) {
        bothStarted.resolve();
      }
      try {
        if (job.id === jobA.id) {
          return await releaseA.promise;
        }
        if (job.id === jobB.id) {
          return await releaseB.promise;
        }
        cStarted.resolve();
        return { status: "ok" as const, summary: "c done" };
      } finally {
        active -= 1;
      }
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const firstTick = onTimer(state);
    await bothStarted.promise;
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobA.id,
      }),
    ).toBeDefined();
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobB.id,
      }),
    ).toBeDefined();
    now = t0 + 60_000;

    await Promise.all([onTimer(state), onTimer(state), onTimer(state)]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.activeTimerTicks).toBe(1);
    expect(state.runAdmission.waiters).toHaveLength(0);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");
    expect(state.queuedRunReservationsByJobId.has(jobC.id)).toBe(false);
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobC.id,
      }),
    ).toBeUndefined();
    const saturatedStore = await loadCronStore(store.storePath);
    expect(saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.queuedAtMs).toBeUndefined();
    expect(
      saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.runningAtMs,
    ).toBeUndefined();

    releaseA.resolve({ status: "ok", summary: "a done" });
    await cStarted.promise;
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobC.id,
      }),
    ).toBeDefined();
    expect(state.runAdmission.capacityListener).toBeNull();
    expect(peakActive).toBe(2);

    releaseB.resolve({ status: "ok", summary: "b done" });
    await firstTick;
    await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    expect(state.queuedRunReservationsByJobId.size).toBe(0);
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobC.id,
      }),
    ).toBeUndefined();
    stop(state);
  });

  it("wakes unreserved receipt-free work when a partial batch releases capacity", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:07:00.000Z");
    const jobA = createDueIsolatedJob({
      id: "partial-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobB = createDueIsolatedJob({
      id: "partial-b",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobC = createDueIsolatedJob({
      id: "partial-c",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [jobA, jobB, jobC],
    });

    let active = 0;
    let peakActive = 0;
    const firstTwoStarted = createDeferred<void>();
    const cStarted = createDeferred<void>();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseB = createDeferred<{ status: "ok"; summary: string }>();
    const releaseC = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (active === 2) {
        firstTwoStarted.resolve();
      }
      try {
        if (job.id === jobA.id) {
          return await releaseA.promise;
        }
        if (job.id === jobB.id) {
          return await releaseB.promise;
        }
        cStarted.resolve();
        return await releaseC.promise;
      } finally {
        active -= 1;
      }
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
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const firstTick = onTimer(state);
    await firstTwoStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobC.id,
      }),
    ).toBeUndefined();

    releaseA.resolve({ status: "ok", summary: "a done" });
    await cStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
    expect(peakActive).toBe(2);
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobC.id,
      }),
    ).toBeDefined();

    releaseB.resolve({ status: "ok", summary: "b done" });
    releaseC.resolve({ status: "ok", summary: "c done" });
    await firstTick;
    await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2);
    expect(state.queuedRunReservationsByJobId.size).toBe(0);
    stop(state);
  });

  it("keeps the next future wake armed while an earlier receipt-backed batch runs", async () => {
    vi.useFakeTimers();
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:08:00.000Z");
    vi.setSystemTime(t0);
    const jobA = createDueIsolatedJob({
      id: "timer-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    jobA.payload = { kind: "agentTurn", message: jobA.id, timeoutSeconds: 0 };
    const jobB = createDueIsolatedJob({
      id: "timer-b",
      nowMs: t0,
      nextRunAtMs: t0 + 30_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB] });

    let active = 0;
    let peakActive = 0;
    const aStarted = createDeferred<void>();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const bStarted = createDeferred<void>();
    const releaseB = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        if (job.id === jobA.id) {
          aStarted.resolve();
          return await releaseA.promise;
        }
        bStarted.resolve();
        return await releaseB.promise;
      } finally {
        active -= 1;
      }
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const tickA = onTimer(state);
    await aStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await bStarted.promise;

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(peakActive).toBe(2);
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: jobB.id,
      }),
    ).toBeDefined();

    releaseB.resolve({ status: "ok", summary: "b done" });
    releaseA.resolve({ status: "ok", summary: "a done" });
    await tickA;
    await vi.advanceTimersByTimeAsync(0);
    expect(state.activeTimerTicks).toBe(0);
    stop(state);
  });
});
