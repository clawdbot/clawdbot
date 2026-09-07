// Failure alerts must describe only cron outcomes that survived durable persistence.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronFailureNotificationDelivery, CronJob, CronRunStatus } from "../types.js";
import { stop as stopCronService } from "./ops-lifecycle.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { applyTriggerNoFireResult } from "./timer-outcomes.js";
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
  return createCronRegressionState({
    storePath: params.storePath,
    nowMs: params.nowMs,
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
  it.each(["error", "ok"] as const)(
    "shares cooldown across alternating failures starting %s",
    (firstStatus) => {
      const store = fixtures.makeStorePath();
      let now = Date.parse("2026-08-01T14:49:00Z");
      const job = createAlertJob({ id: "shared-alert-cooldown", dueAt: now });
      job.delivery = {
        mode: "announce",
        failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
      };
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      for (const status of [firstStatus, firstStatus === "error" ? "ok" : "error"] as const) {
        applyJobResult(state, job, {
          status,
          delivered: false,
          error: status === "error" ? "execution failed" : undefined,
          deliveryError: "primary rejected",
          startedAt: now,
          endedAt: now,
        });
        now += 1_000;
      }
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      applyJobResult(state, job, { status: "ok", delivered: true, startedAt: now, endedAt: now });
      expect(job.state.lastFailureAlertAtMs).toBeUndefined();
      applyJobResult(state, job, {
        status: "ok",
        delivered: false,
        deliveryError: "primary rejected",
        startedAt: now,
        endedAt: now,
      });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["skipped run", "quiet trigger"])(
    "keeps delivery cooldown across a %s",
    (intervening) => {
      const store = fixtures.makeStorePath();
      const firstAt = Date.parse("2026-08-01T14:49:00Z");
      let now = firstAt;
      const job = createAlertJob({ id: "delivery-alert-order", dueAt: now });
      job.delivery = {
        mode: "announce",
        failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
      };
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => now,
        sendCronFailureAlert,
      });
      const failDelivery = () =>
        applyJobResult(state, job, {
          status: "ok",
          delivered: false,
          deliveryError: "primary rejected",
          startedAt: now,
          endedAt: now,
        });
      failDelivery();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      now += 1_000;
      if (intervening === "skipped run") {
        applyJobResult(state, job, { status: "skipped", startedAt: now, endedAt: now });
      } else {
        applyTriggerNoFireResult(state, job, {
          startedAt: now,
          endedAt: now,
          triggerEval: { fired: false, stateChanged: false },
        });
      }
      now += 1_000;
      failDelivery();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(job.state.lastFailureAlertAtMs).toBe(firstAt);
    },
  );

  it.each(
    [
      {
        name: "recorded attempt",
        notification: { status: "unknown" as const },
        priorOffset: -20_000,
        expectedOffset: 0,
      },
      {
        name: "newer alert",
        notification: { status: "delivered" as const, delivered: true },
        priorOffset: 10_000,
        expectedOffset: 10_000,
      },
      {
        name: "future timestamp",
        notification: { status: "unknown" as const },
        priorOffset: 120_000,
        expectedOffset: 0,
      },
      {
        name: "suppressed alert",
        notification: { status: "not-requested" as const },
        priorOffset: -120_000,
        expectedOffset: -120_000,
      },
      {
        name: "absent fact",
        notification: undefined,
        priorOffset: -120_000,
        expectedOffset: -120_000,
      },
    ].flatMap((testCase) =>
      (["ok", "error", "skipped"] as const).flatMap((status) =>
        [false, true].map((enabled) => ({ testCase, name: testCase.name, status, enabled })),
      ),
    ),
  )(
    "restores $status cooldown from $name (alerts enabled=$enabled) without transport",
    ({ testCase, status, enabled }) => {
      const endedAt = Date.parse("2026-08-01T14:50:00Z");
      const store = fixtures.makeStorePath();
      const job = createAlertJob({ id: "delivery-replay", dueAt: endedAt - 10 });
      job.delivery = { mode: "none" };
      job.failureAlert = enabled ? { after: 1, cooldownMs: 60_000, includeSkipped: true } : false;
      job.state.lastFailureAlertAtMs = endedAt + testCase.priorOffset;
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => endedAt + 30_000,
        sendCronFailureAlert,
      });
      const deferredNotifications: Array<() => void> = [];
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: endedAt - 10,
        deferredNotifications,
        entry: {
          ts: endedAt,
          jobId: job.id,
          action: "finished",
          status,
          completionStatus: "failed",
          deliveryStatus: "not-delivered",
          deliveryError: "primary rejected",
          failureNotificationDelivery: testCase.notification,
          runAtMs: endedAt - 10,
        },
      });
      expect(job.state.lastFailureAlertAtMs).toBe(endedAt + testCase.expectedOffset);
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe(
        testCase.notification?.status ?? "not-requested",
      );
      expect(deferredNotifications).toEqual([]);
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

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
      { replay: true, deferredNotifications },
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
      lastFailureNotificationDeliveryStatus: "unknown",
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

describe("cron failure alert outcome write-back", () => {
  const dueAt = Date.parse("2026-08-01T15:00:00.000Z");
  const endedAt = dueAt + 10;

  async function runFailure(params: { id: string; sendCronFailureAlert: SendCronFailureAlert }) {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: params.id, dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert: params.sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
    });
    return { store, state };
  }

  it.each([
    {
      name: "delivered",
      outcome: { delivered: true, status: "delivered" },
    },
    {
      name: "not delivered",
      outcome: {
        delivered: false,
        status: "not-delivered",
        error: "alert channel exploded",
      },
    },
    {
      name: "unknown",
      outcome: { status: "unknown", error: "later delivery work failed" },
    },
  ] satisfies Array<{ name: string; outcome: CronFailureNotificationDelivery }>)(
    "persists a $name outcome once the send settles",
    async ({ name, outcome }) => {
      const { store } = await runFailure({
        id: `alert-outcome-${name.replaceAll(" ", "-")}`,
        sendCronFailureAlert: vi.fn(async (params) => {
          await params.onDeliverySettled(outcome);
        }),
      });

      await vi.waitFor(async () => {
        expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
          lastFailureAlertAtMs: endedAt,
          lastFailureNotificationDeliveryStatus: outcome.status,
        });
      });
      const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
      expect(persisted?.lastFailureNotificationDelivered).toBe(outcome.delivered);
      expect(persisted?.lastFailureNotificationDeliveryError).toBe(outcome.error);
    },
  );

  it("redacts transport errors before persisting them", async () => {
    const err = new Error(
      `webhook rejected: token=abcdefghijklmnopqrstuvwxyz123456 ${"x".repeat(2_000)}`,
    );
    const { store } = await runFailure({
      id: "alert-outcome-redacted-error",
      sendCronFailureAlert: vi.fn(async (params) => {
        await params.onDeliverySettled({
          delivered: false,
          status: "not-delivered",
          error: err.message,
        });
      }),
    });

    await vi.waitFor(async () => {
      expect(
        (await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureNotificationDeliveryStatus,
      ).toBe("not-delivered");
    });
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state
      .lastFailureNotificationDeliveryError;
    expect(persisted).toHaveLength(1_000);
    expect(formatErrorMessage(err).length).toBeGreaterThan(1_000);
    expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("does not overwrite a newer alert cycle committed by a sibling service", async () => {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: "alert-outcome-sibling-cycle", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    // Service A: the send stays in flight while a sibling commits a newer cycle.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const sendA = vi.fn(async (params) => {
      await gateA;
      await params.onDeliverySettled({ delivered: true, status: "delivered" });
    });
    const stateA = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert: sendA,
    });
    await finalizeAlertOutcome({
      state: stateA,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
    });

    // Service B on the same store: a later failure past the cooldown starts a
    // newer alert cycle and commits it.
    const laterAt = endedAt + 600_000;
    const sendB = vi.fn(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "recipient not reached",
      });
    });
    const stateB = createAlertState({
      storePath: store.storePath,
      nowMs: () => laterAt,
      sendCronFailureAlert: sendB,
    });
    const jobForB = structuredClone(job);
    jobForB.state.runningAtMs = laterAt;
    await finalizeAlertOutcome({
      state: stateB,
      job: jobForB,
      status: "error",
      error: "provider unavailable again",
      startedAt: laterAt - 10,
      endedAt: laterAt,
    });
    await vi.waitFor(async () => {
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastFailureAlertAtMs).toBe(
        laterAt,
      );
    });

    // Service A's delayed send settles with a stale snapshot; it must not
    // overwrite the sibling's newer cycle.
    releaseA?.();
    await sendA.mock.results[0]?.value;
    await Promise.resolve();
    await stateA.op;
    await Promise.resolve();
    await stateA.op;

    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.lastFailureAlertAtMs).toBe(laterAt);
    expect(persisted?.lastFailureNotificationDelivered).not.toBe(true);
  });

  it("restores the live fields when the outcome persist fails", async () => {
    const store = fixtures.makeStorePath();
    const job = createAlertJob({ id: "alert-outcome-persist-restore", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => endedAt,
      sendCronFailureAlert,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt,
    });

    // The run itself is durable; from here on every write to this row fails.
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_outcome_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'outcome write failed');
      END;
    `);
    try {
      releaseSend?.();
      await sendCronFailureAlert.mock.results[0]?.value;
      await Promise.resolve();
      await state.op;
      await Promise.resolve();
      await state.op;

      // The live gateway must not report an outcome SQLite refused to commit.
      const live = state.store?.jobs[0]?.state;
      expect(live?.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(live?.lastFailureNotificationDelivered).toBeUndefined();
      expect(live?.lastFailureNotificationDeliveryError).toBeUndefined();
      const durable = (await loadCronStore(store.storePath)).jobs[0]?.state;
      expect(durable?.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(durable?.lastFailureNotificationDelivered).toBeUndefined();
      expect(durable?.lastFailureNotificationDeliveryError).toBeUndefined();
      expect(state.deps.enqueueSystemEvent).toHaveBeenCalledOnce();
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_outcome_write;");
    }
  });

  it("does not overwrite a newer run in the same alert cooldown cycle", async () => {
    let resolveSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const { store, state } = await runFailure({
      id: "alert-outcome-same-cycle-newer-run",
      sendCronFailureAlert,
    });
    const currentJob = state.store?.jobs[0];
    if (!currentJob) {
      throw new Error("expected persisted cron job");
    }
    const laterAt = endedAt + 1_000;
    currentJob.state.runningAtMs = laterAt;
    await finalizeAlertOutcome({
      state,
      job: currentJob,
      status: "error",
      error: "provider still unavailable",
      startedAt: laterAt,
      endedAt: laterAt + 10,
    });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();

    resolveSend?.();
    await sendCronFailureAlert.mock.results[0]?.value;
    const durable = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(durable).toMatchObject({
      lastRunAtMs: laterAt,
      lastFailureAlertAtMs: endedAt,
      lastFailureNotificationDeliveryStatus: "not-requested",
    });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not write after the service lifecycle retires", async () => {
    let resolveSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendCronFailureAlert = vi.fn(async (params) => {
      await sendGate;
      await params.onDeliverySettled({ delivered: false, status: "not-delivered" });
    });
    const { store, state } = await runFailure({
      id: "alert-outcome-retired-lifecycle",
      sendCronFailureAlert,
    });

    stopCronService(state);
    resolveSend?.();
    await sendCronFailureAlert.mock.results[0]?.value;

    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      lastFailureNotificationDeliveryStatus: "unknown",
    });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
