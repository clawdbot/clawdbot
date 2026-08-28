// Failure alerts must describe only cron outcomes that survived durable persistence.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { applyJobResult, authorCronRunCompletion } from "./timer.js";

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
      ...authorCronRunCompletion(params.state, params.job, {
        status: params.status,
        error: params.error,
      }),
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
    let resolveAlert: (() => void) | undefined;
    const alertDone = new Promise<void>((resolve) => {
      resolveAlert = resolve;
    });
    let persistedStateAtSend: CronJob["state"] | undefined;
    const sendCronFailureAlert = vi.fn(async () => {
      persistedStateAtSend = (await loadCronStore(store.storePath)).jobs[0]?.state;
      order.push("persist");
      order.push("alert");
      resolveAlert?.();
    });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: testCase.status,
      error: testCase.status === "error" ? "provider unavailable" : "disabled",
      startedAt: dueAt,
      endedAt,
    });
    await alertDone;

    expect(order).toEqual(["persist", "alert"]);
    expect(persistedStateAtSend).toMatchObject({
      lastFailureAlertAtMs: endedAt,
      lastFailureNotificationDeliveryStatus: "unknown",
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "error", includeSkipped: false },
    { status: "skipped", includeSkipped: true },
  ] as const)(
    "resumes $status alerts after a clock rollback and restores their cooldown",
    async (testCase) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-08-01T14:52:00.000Z");
      const job = createAlertJob({
        id: `${testCase.status}-alert-clock-rollback`,
        dueAt,
        includeSkipped: testCase.includeSkipped,
      });
      job.state.lastFailureAlertAtMs = dueAt + 3_600_000;
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });

      await finalizeAlertOutcome({
        state,
        job,
        status: testCase.status,
        error: "provider unavailable",
        startedAt: now,
        endedAt: now + 10,
      });

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(now);

      now += 30_000;
      const currentJob = state.store?.jobs[0];
      if (!currentJob) {
        throw new Error("expected persisted cron job");
      }
      await finalizeAlertOutcome({
        state,
        job: currentJob,
        status: testCase.status,
        error: "provider still unavailable",
        startedAt: now,
        endedAt: now + 10,
      });

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
        dueAt,
      );
    },
  );

  it("preserves a newer cooldown when replaying an older finalized failure", () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-08-01T14:54:00.000Z");
    const replayedAt = now - 30_000;
    const previousAlertAt = now - 10_000;
    const job = createAlertJob({ id: "failure-alert-historical-replay", dueAt: replayedAt });
    job.state.lastFailureAlertAtMs = previousAlertAt;

    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });
    const deferredNotifications: Array<() => void> = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "historical failure",
        startedAt: replayedAt - 10,
        endedAt: replayedAt,
      },
      { replayFailureAlertAtMs: replayedAt, deferredNotifications },
    );

    expect(job.state.lastFailureAlertAtMs).toBe(previousAlertAt);
    expect(deferredNotifications).toEqual([]);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
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
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_failure_alert_terminal_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'terminal write failed');
      END;
    `);

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
      database.exec("DROP TRIGGER IF EXISTS reject_failure_alert_terminal_write");
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
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      lastFailureAlertAtMs: firstAlertAt,
      lastFailureNotificationDelivered: true,
      lastFailureNotificationDeliveryStatus: "delivered",
    });

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
      state: {
        consecutiveErrors: 2,
        lastFailureAlertAtMs: firstAlertAt,
        lastFailureNotificationDeliveryStatus: "not-requested",
      },
    });
  });
});
