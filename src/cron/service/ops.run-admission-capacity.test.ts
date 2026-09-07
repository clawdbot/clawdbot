// Capacity-edge regressions cover stopped direct runs and saturated scheduled work.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { onTimer } from "./timer.test-support.js";

const capacityFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-capacity-",
});

type CronStateParams = Parameters<typeof createCronRegressionState>[0] & {
  testAdmissionLimit?: number;
};

function createAdmissionTestState(params: CronStateParams) {
  const { testAdmissionLimit, ...stateParams } = params;
  const state = createCronRegressionState(stateParams);
  if (testAdmissionLimit !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - testAdmissionLimit;
  }
  return state;
}

describe("cron service run admission capacity edges", () => {
  it("releases a direct manual reservation when stop wins its admission wait", async () => {
    const store = capacityFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:07.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-manual-stop",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "stopped-manual-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const state = createAdmissionTestState({
      storePath: store.storePath,
      testAdmissionLimit: 1,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
        if (runningJob.id === activeJob.id) {
          activeStarted.resolve();
          return await releaseActive.promise;
        }
        return { status: "ok" as const, summary: "should not run" };
      }),
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    stop(state);
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
    expect(
      state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
  });

  it("keeps saturated scheduled work unreserved when it is rescheduled", async () => {
    const store = capacityFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:08.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const scheduledJob = createDueIsolatedJob({
      id: "rescheduled-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, scheduledJob] });

    const activeStarted = createDeferred();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
      if (runningJob.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createAdmissionTestState({
      storePath: store.storePath,
      testAdmissionLimit: 1,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    await onTimer(state);
    expect(
      state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.queuedAtMs,
    ).toBeUndefined();
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: scheduledJob.id,
      }),
    ).toBeUndefined();
    await update(state, scheduledJob.id, {
      schedule: { kind: "at", at: new Date(dueAt + 3_600_000).toISOString() },
    });

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await vi.waitFor(() => expect(state.runAdmission.capacityListener).toBeNull());
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(
      state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), scheduledJob.id) as { status: string } | undefined;
    expect(receipt).toBeUndefined();
  });
});
