// Failure alerts must describe only cron outcomes that survived durable persistence.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { markCronJobActive } from "../active-jobs.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-failure-alert-persistence-",
});

type SendCronFailureAlert = NonNullable<
  Parameters<typeof createCronServiceState>[0]["sendCronFailureAlert"]
>;

function createAlertJob(params: { id: string; dueAt: number; includeSkipped?: boolean }): CronJob {
  const job = createDueIsolatedJob({
    id: params.id,
    nowMs: params.dueAt,
    nextRunAtMs: params.dueAt,
  });
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: params.dueAt - 60_000 };
  job.failureAlert = {
    after: 1,
    cooldownMs: 60_000,
    ...(params.includeSkipped ? { includeSkipped: true } : {}),
  };
  job.state.runningAtMs = params.dueAt;
  return job;
}

function createAlertState(params: {
  storePath: string;
  nowMs: () => number;
  sendCronFailureAlert: SendCronFailureAlert;
}) {
  return createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: noopLogger,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    sendCronFailureAlert: params.sendCronFailureAlert,
    runIsolatedAgentJob: vi.fn(),
  });
}

async function finalizeAlertOutcome(params: {
  state: ReturnType<typeof createCronServiceState>;
  job: CronJob;
  status: Extract<CronRunStatus, "error" | "skipped">;
  error: string;
  startedAt: number;
  endedAt: number;
}) {
  await finalizeCompletedCronRunOutcomes(params.state, [
    {
      jobId: params.job.id,
      job: structuredClone(params.job),
      activeJobMarker: markCronJobActive(params.job.id),
      status: params.status,
      error: params.error,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    },
  ]);
}

describe("cron failure alert persistence", () => {
  it.each([
    { status: "error", includeSkipped: false },
    { status: "skipped", includeSkipped: true },
  ] as const)("delivers a $status alert once after the outcome is durable", async (testCase) => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:50:00.000Z");
    const endedAt = dueAt + 10;
    const job = createAlertJob({
      id: `${testCase.status}-alert-after-persist`,
      dueAt,
      includeSkipped: testCase.includeSkipped,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const order: string[] = [];
    const sendCronFailureAlert = vi.fn(async () => {
      order.push("alert");
    });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert,
    });
    const save = cronStoreModule.saveCronJobsStore;
    const saveSpy = vi
      .spyOn(cronStoreModule, "saveCronJobsStore")
      .mockImplementation(async (...args) => {
        if (args[1].jobs[0]?.state.lastFailureAlertAtMs === endedAt) {
          expect(sendCronFailureAlert).not.toHaveBeenCalled();
          await save(...args);
          order.push("persist");
          return;
        }
        await save(...args);
      });

    try {
      await finalizeAlertOutcome({
        state,
        job,
        status: testCase.status,
        error: testCase.status === "error" ? "provider unavailable" : "disabled",
        startedAt: dueAt,
        endedAt,
      });

      expect(order).toEqual(["persist", "alert"]);
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
        endedAt,
      );
    } finally {
      saveSpy.mockRestore();
    }
  });

  it("rolls back the cooldown without delivery when persistence fails", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:55:00.000Z");
    const job = createAlertJob({ id: "failure-alert-persist-rollback", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => dueAt + 10,
      sendCronFailureAlert,
    });
    const saveSpy = vi
      .spyOn(cronStoreModule, "saveCronJobsStore")
      .mockRejectedValueOnce(new Error("terminal write failed"));

    try {
      await expect(
        finalizeAlertOutcome({
          state,
          job,
          status: "error",
          error: "provider unavailable",
          startedAt: dueAt,
          endedAt: dueAt + 10,
        }),
      ).rejects.toThrow("terminal write failed");

      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(state.store?.jobs[0]?.state.lastFailureAlertAtMs).toBeUndefined();
      expect(
        (await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs,
      ).toBeUndefined();
    } finally {
      saveSpy.mockRestore();
    }
  });

  it("persists the cooldown atomically and suppresses a second alert", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T14:58:00.000Z");
    const firstAlertAt = dueAt + 10;
    const job = createAlertJob({ id: "failure-alert-cooldown-persisted", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let now = firstAlertAt;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });

    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "first failure",
      startedAt: dueAt,
      endedAt: firstAlertAt,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
      firstAlertAt,
    );

    now += 30_000;
    const currentJob = state.store?.jobs[0];
    if (!currentJob) {
      throw new Error("expected persisted cron job");
    }
    await finalizeAlertOutcome({
      state,
      job: currentJob,
      status: "error",
      error: "second failure",
      startedAt: now,
      endedAt: now + 10,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      state: { consecutiveErrors: 2, lastFailureAlertAtMs: firstAlertAt },
    });
  });
});
