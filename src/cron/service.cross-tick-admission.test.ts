// Cross-tick admission must stay concurrent without retaining saturated timer work (#119083).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-admission-",
});

function createAdmissionTestState(
  params: Parameters<typeof createCronServiceState>[0] & { availableSlots: number },
): CronServiceState {
  const { availableSlots, ...deps } = params;
  const state = createCronServiceState(deps);
  state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - availableSlots;
  return state;
}

describe("cron service cross-tick bounded admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a later-due job while an earlier timer batch still runs", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    const jobA = createDueIsolatedJob({ id: "cross-tick-a", nowMs: t0, nextRunAtMs: t0 });
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
    const state = createAdmissionTestState({
      availableSlots: 2,
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const tickA = onTimer(state);
    await aStarted.promise;
    now = t0 + 60_000;
    const tickB = onTimer(state);
    await bStarted.promise;

    expect(peakActive).toBe(2);
    expect(state.activeTimerTicks).toBe(2);
    expect(state.runAdmission.waiters).toHaveLength(0);

    releaseA.resolve({ status: "ok", summary: "a done" });
    await Promise.all([tickA, tickB]);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.activeTimerTicks).toBe(0);
    expect(state.running).toBe(false);
    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.every((job) => job.state.queuedAtMs === undefined)).toBe(true);
    expect(persisted.jobs.every((job) => job.state.runningAtMs === undefined)).toBe(true);
    expect(persisted.jobs.every((job) => job.state.lastRunStatus === "ok")).toBe(true);
  });

  it("does not reserve or retain timer batches while all slots are full", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    const jobA = createDueIsolatedJob({ id: "saturated-a", nowMs: t0, nextRunAtMs: t0 });
    const jobB = createDueIsolatedJob({ id: "saturated-b", nowMs: t0, nextRunAtMs: t0 });
    const jobC = createDueIsolatedJob({
      id: "saturated-later",
      nowMs: t0,
      nextRunAtMs: t0 + 60_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB, jobC] });

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
    const state = createAdmissionTestState({
      availableSlots: 2,
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const firstTick = onTimer(state);
    await bothStarted.promise;
    now = t0 + 60_000;

    // Repeated saturated ticks must settle immediately instead of queueing
    // Gateway roots or admission promises.
    await Promise.all([onTimer(state), onTimer(state), onTimer(state)]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.activeTimerTicks).toBe(1);
    expect(state.runAdmission.waiters).toHaveLength(0);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");
    expect(state.queuedRunReservationsByJobId.has(jobC.id)).toBe(false);
    const saturatedStore = await loadCronStore(store.storePath);
    expect(saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.queuedAtMs).toBeUndefined();
    expect(
      saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.runningAtMs,
    ).toBeUndefined();
    const releasedAt = performance.now();
    releaseA.resolve({ status: "ok", summary: "a done" });
    await cStarted.promise;
    const capacityWakeDelayMs = performance.now() - releasedAt;
    // The capacity listener itself must start overdue work; a direct onTimer
    // call here would hide regressions back to the 2s past-due refire floor.
    expect(capacityWakeDelayMs).toBeLessThan(1_000);
    expect(state.runAdmission.capacityListener).toBeNull();
    expect(peakActive).toBe(2);

    releaseB.resolve({ status: "ok", summary: "b done" });
    await firstTick;
    await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    expect(state.activeTimerTicks).toBe(0);
    expect(state.queuedRunReservationsByJobId.size).toBe(0);
  });

  it("wakes unreserved due work when a partially admitted job releases capacity", async () => {
    vi.useFakeTimers();
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(t0);
    const jobA = createDueIsolatedJob({ id: "partial-a", nowMs: t0, nextRunAtMs: t0 });
    const jobB = createDueIsolatedJob({ id: "partial-b", nowMs: t0, nextRunAtMs: t0 });
    const jobC = createDueIsolatedJob({ id: "partial-c", nowMs: t0, nextRunAtMs: t0 });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB, jobC] });

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
    const state = createAdmissionTestState({
      availableSlots: 2,
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const firstTick = onTimer(state);
    await firstTwoStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");
    const partialBatchListener = state.runAdmission.capacityListener;

    // A later tick with no free slots must not replace the partial batch's
    // activation-gated wake-up with an unconditional recheck.
    await onTimer(state);
    expect(state.runAdmission.capacityListener).toBe(partialBatchListener);
    const partiallyReservedStore = await loadCronStore(store.storePath);
    expect(
      partiallyReservedStore.jobs.find((job) => job.id === jobC.id)?.state.queuedAtMs,
    ).toBeUndefined();

    releaseA.resolve({ status: "ok", summary: "a done" });
    await cStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
    expect(peakActive).toBe(2);
    expect(state.runAdmission.capacityListener).toBeNull();

    releaseB.resolve({ status: "ok", summary: "b done" });
    releaseC.resolve({ status: "ok", summary: "c done" });
    await firstTick;
    await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    expect(state.queuedRunReservationsByJobId.size).toBe(0);
  });

  it("arms the next unclaimed wake while an earlier batch is still running", async () => {
    vi.useFakeTimers();
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(t0);
    const jobA = createDueIsolatedJob({ id: "timer-a", nowMs: t0, nextRunAtMs: t0 });
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
    const state = createAdmissionTestState({
      availableSlots: 2,
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const tickA = onTimer(state);
    await aStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await bStarted.promise;

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(peakActive).toBe(2);

    releaseA.resolve({ status: "ok", summary: "a done" });
    await tickA;
    await vi.advanceTimersByTimeAsync(0);
    expect(state.activeTimerTicks).toBe(0);
  });
});
