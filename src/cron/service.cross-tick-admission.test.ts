// Scheduled work must use free shared-admission slots across timer ticks (#119083).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { stop } from "./service/ops-lifecycle.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  inspectActiveCronRunReceipt,
  prepareCronRunReceiptClaim,
  type CronRunReceiptHandle,
} from "./store/run-receipt-store.js";
import type { CronJob } from "./types.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-admission-",
});

describe("cron service cross-tick bounded admission", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
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
    const aStarted = createDeferred();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const bStarted = createDeferred();
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
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
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

  it("keeps saturated work unreserved and its capacity wake independently admitted", async () => {
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
    const bothStarted = createDeferred();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const releaseB = createDeferred<{ status: "ok"; summary: string }>();
    const cStarted = createDeferred();
    const releaseC = createDeferred<{ status: "ok"; summary: string }>();
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
        return await releaseC.promise;
      } finally {
        active -= 1;
      }
    });
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
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
    expect(getActiveGatewayRootWorkCount()).toBe(2);
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
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    releaseC.resolve({ status: "ok", summary: "c done" });
    await vi.waitFor(() => expect(state.activeTimerTicks).toBe(0));
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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
    const firstTwoStarted = createDeferred();
    const cStarted = createDeferred();
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
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => t0,
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

  it("rechecks a partial batch immediately when its only reservation conflicts", async () => {
    const store = fixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:07:30.000Z");
    const conflicted = createDueIsolatedJob({
      id: "partial-conflict",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const pending = createDueIsolatedJob({
      id: "partial-after-conflict",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [conflicted, pending] });

    const foreignStartedAtMs = t0 + 1;
    const preparedForeignReceipt = prepareCronRunReceiptClaim({
      storePath: store.storePath,
      job: conflicted,
      agentId: conflicted.agentId ?? "main",
      startedAtMs: foreignStartedAtMs,
    });
    let foreignReceipt: CronRunReceiptHandle | undefined;
    let nowCalls = 0;
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      expect(job.id).toBe(pending.id);
      return { status: "ok" as const, summary: "pending done" };
    });
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => {
        nowCalls += 1;
        // The third scheduler time read occurs after due-job collection and
        // immediately before receipt reservation. Simulate a sibling winning
        // the durable owner race at that boundary.
        if (nowCalls === 3) {
          foreignReceipt = runOpenClawStateWriteTransaction(({ db }) => {
            const receipt = claimCronRunReceiptInDatabase({
              database: db,
              prepared: preparedForeignReceipt,
              resolveAgentId: (job) => job.agentId ?? "main",
            });
            db.prepare(
              `UPDATE cron_jobs
                  SET state_json = json_set(state_json, '$.runningAtMs', ?),
                      updated_at = updated_at + 1
                WHERE store_key = ? AND job_id = ?`,
            ).run(foreignStartedAtMs, cronStoreKey(store.storePath), conflicted.id);
            return receipt;
          });
        }
        return t0;
      },
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1;

    try {
      await onTimer(state);

      expect(foreignReceipt).toBeDefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
      expect(state.runAdmission.capacityListener).toBeNull();
      expect(state.activeTimerTicks).toBe(0);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((job) => job.id === pending.id)?.state,
      ).toMatchObject({ lastRunStatus: "ok" });
    } finally {
      if (foreignReceipt) {
        finishCronRunReceipt({
          handle: foreignReceipt,
          status: "interrupted",
          finishedAtMs: t0 + 2,
        });
      }
      stop(state);
    }
  });

  it("runs the next future wake under its own Gateway root while an earlier batch runs", async () => {
    vi.useRealTimers();
    const store = fixtures.makeStorePath();
    const t0 = Date.now();
    const jobA = createDueIsolatedJob({
      id: "timer-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    jobA.payload = { kind: "agentTurn", message: jobA.id, timeoutSeconds: 0 };
    const jobB = createDueIsolatedJob({
      id: "timer-b",
      nowMs: t0,
      nextRunAtMs: t0 + 500,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB] });

    let active = 0;
    let peakActive = 0;
    const aStarted = createDeferred();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const bStarted = createDeferred();
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
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => Date.now(),
      runIsolatedAgentJob,
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2;

    const tickA = onTimer(state);
    try {
      await aStarted.promise;
      await bStarted.promise;

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      expect(peakActive).toBe(2);
      expect(
        inspectActiveCronRunReceipt({
          storePath: store.storePath,
          jobId: jobB.id,
        }),
      ).toBeDefined();
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      releaseA.resolve({ status: "ok", summary: "a done" });
      await tickA;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      releaseB.resolve({ status: "ok", summary: "b done" });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(state.activeTimerTicks).toBe(0);
    } finally {
      releaseA.resolve({ status: "ok", summary: "a cleanup" });
      releaseB.resolve({ status: "ok", summary: "b cleanup" });
      await tickA;
      stop(state);
    }
  });
});
