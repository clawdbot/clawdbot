// Failure alerts must describe only cron outcomes that survived durable persistence.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { createCronExecutionId } from "../run-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
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
  sendCronFailureAlert?: SendCronFailureAlert;
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
}) {
  return createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: noopLogger,
    nowMs: params.nowMs,
    enqueueSystemEvent: params.enqueueSystemEvent ?? vi.fn(),
    requestHeartbeat: vi.fn(),
    ...(params.sendCronFailureAlert ? { sendCronFailureAlert: params.sendCronFailureAlert } : {}),
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
  taskRunId?: string;
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
      ...(params.taskRunId !== undefined ? { taskRunId: params.taskRunId } : {}),
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

  it("writes the settled success outcome back to job state and run history", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:00:00.000Z");
    const job = createAlertJob({ id: "failure-alert-outcome-success", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => dueAt + 10,
      sendCronFailureAlert: async () => undefined,
    });
    const taskRunId = `${createCronExecutionId(job.id, dueAt)}:${randomUUID()}`;
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt: dueAt + 10,
      taskRunId,
    });

    await vi.waitFor(() =>
      expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered"),
    );
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.lastFailureNotificationDelivered).toBe(true);
    expect(persisted?.lastFailureNotificationDeliveryStatus).toBe("delivered");
    expect(persisted?.lastFailureNotificationDeliveryError).toBeUndefined();

    const history = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(store.storePath),
      jobId: job.id,
      limit: 5,
    });
    expect(history.entries[0]?.failureNotificationDelivery).toEqual({
      delivered: true,
      status: "delivered",
    });
  });

  it("writes the settled failure outcome with its error back to job state and run history", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:01:00.000Z");
    const job = createAlertJob({ id: "failure-alert-outcome-failure", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => dueAt + 10,
      sendCronFailureAlert: async () => {
        throw new Error("webhook unreachable");
      },
      enqueueSystemEvent,
    });
    const taskRunId = `${createCronExecutionId(job.id, dueAt)}:${randomUUID()}`;
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt: dueAt + 10,
      taskRunId,
    });

    await vi.waitFor(() =>
      expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe(
        "not-delivered",
      ),
    );
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.lastFailureNotificationDelivered).toBe(false);
    expect(persisted?.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
    expect(persisted?.lastFailureNotificationDeliveryError).toContain("webhook unreachable");

    const history = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(store.storePath),
      jobId: job.id,
      limit: 5,
    });
    expect(history.entries[0]?.failureNotificationDelivery).toEqual({
      delivered: false,
      status: "not-delivered",
      error: expect.stringContaining("webhook unreachable"),
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("failed 1 times"),
      expect.objectContaining({ contextKey: `cron:${job.id}:failure-alert` }),
    );
  });

  it("records the fallback outcome when no failure-alert transport is available", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:02:00.000Z");
    const job = createAlertJob({ id: "failure-alert-outcome-no-transport", dueAt });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => dueAt + 10,
      enqueueSystemEvent,
    });
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "provider unavailable",
      startedAt: dueAt,
      endedAt: dueAt + 10,
    });

    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.lastFailureNotificationDelivered).toBe(false);
    expect(persisted?.lastFailureNotificationDeliveryStatus).toBe("not-delivered");
    expect(persisted?.lastFailureNotificationDeliveryError).toBe(
      "failure alert transport unavailable",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("failed 1 times"),
      expect.objectContaining({ contextKey: `cron:${job.id}:failure-alert` }),
    );
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

  it("settles each overlapping alert on its own run-history row in reverse settlement order", async () => {
    // Two eligible failures fire before the first alert settles (cooldownMs=0).
    // Alert B (newer run) settles first, alert A (older run) settles second.
    // Each outcome must land only on its own run-history row; job state must
    // reflect B's outcome since B is the most recently started alert.
    const store = fixtures.makeStorePath();
    const startedAtA = Date.parse("2026-08-01T16:10:00.000Z");
    const startedAtB = startedAtA + 1;
    const job = createAlertJob({ id: "failure-alert-reverse-settlement", dueAt: startedAtA });
    job.failureAlert = { after: 1, cooldownMs: 0 };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    // Stable run-history row IDs so we can assert exact settlement.
    const taskRunIdA = `${createCronExecutionId(job.id, startedAtA)}:${randomUUID()}`;
    const taskRunIdB = `${createCronExecutionId(job.id, startedAtB)}:${randomUUID()}`;

    // Each sendCronFailureAlert call gets its own deferred so we control order.
    type Deferred = { resolve: () => void; reject: (e: unknown) => void };
    const pendingAlerts: Deferred[] = [];
    const sendCronFailureAlert = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          pendingAlerts.push({ resolve, reject });
        }),
    );

    let now = startedAtA + 10;
    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => now,
      sendCronFailureAlert,
    });

    // Run A: fires alert A, transport paused.
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "first failure",
      startedAt: startedAtA,
      endedAt: startedAtA + 10,
      taskRunId: taskRunIdA,
    });
    expect(pendingAlerts).toHaveLength(1);

    // Run B: fires alert B with cooldownMs=0, transport paused.
    now = startedAtB + 10;
    const jobAfterA = state.store?.jobs[0];
    if (!jobAfterA) throw new Error("expected job after run A");
    await finalizeAlertOutcome({
      state,
      job: jobAfterA,
      status: "error",
      error: "second failure",
      startedAt: startedAtB,
      endedAt: startedAtB + 10,
      taskRunId: taskRunIdB,
    });
    expect(pendingAlerts).toHaveLength(2);

    // Settle B first (out of order), then A.
    pendingAlerts[1]!.resolve();
    await vi.waitFor(() =>
      expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered"),
    );

    const historyAfterB = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(store.storePath),
      jobId: job.id,
      limit: 5,
    });
    // B's row is settled; A's row still "unknown". Rows are identified by runAtMs.
    const rowA = historyAfterB.entries.find((e) => e.runAtMs === startedAtA);
    const rowB = historyAfterB.entries.find((e) => e.runAtMs === startedAtB);
    expect(rowB?.failureNotificationDelivery).toEqual({ delivered: true, status: "delivered" });
    expect(rowA?.failureNotificationDelivery).toEqual({ status: "unknown" });

    // Job state must reflect B's outcome.
    expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
    expect(state.store?.jobs[0]?.state.lastFailureAlertAtMs).toBe(startedAtB + 10);

    // Now settle A.
    pendingAlerts[0]!.resolve();
    await vi.waitFor(() => {
      // A's run-history row must now be settled.
      const history = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(store.storePath),
        jobId: job.id,
        limit: 5,
      });
      const entryA = history.entries.find((e) => e.runAtMs === startedAtA);
      expect(entryA?.failureNotificationDelivery).toEqual({ delivered: true, status: "delivered" });
    });

    // Job state must still reflect B's outcome (A's callback must not clobber it).
    expect(state.store?.jobs[0]?.state.lastFailureAlertAtMs).toBe(startedAtB + 10);
    expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
  });

  it("settles two alerts that share the same wall-clock millisecond onto their own history rows", async () => {
    // Two runs whose endedAt land on the exact same millisecond get distinct
    // taskRunIds. The old alertAtMs guard could not distinguish them; the
    // taskRunId guard must correctly route each settlement.
    const store = fixtures.makeStorePath();
    const sharedMs = Date.parse("2026-08-01T16:20:00.000Z");
    const job = createAlertJob({ id: "failure-alert-same-ms", dueAt: sharedMs });
    job.failureAlert = { after: 1, cooldownMs: 0 };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const taskRunIdA = `${createCronExecutionId(job.id, sharedMs)}:${randomUUID()}`;
    const taskRunIdB = `${createCronExecutionId(job.id, sharedMs)}:${randomUUID()}`;

    type Deferred = { resolve: () => void };
    const pendingAlerts: Deferred[] = [];
    const sendCronFailureAlert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pendingAlerts.push({ resolve });
        }),
    );

    const state = createAlertState({
      storePath: store.storePath,
      nowMs: () => sharedMs,
      sendCronFailureAlert,
    });

    // Run A and B both share endedAt = sharedMs.
    await finalizeAlertOutcome({
      state,
      job,
      status: "error",
      error: "first failure",
      startedAt: sharedMs,
      endedAt: sharedMs,
      taskRunId: taskRunIdA,
    });
    expect(pendingAlerts).toHaveLength(1);

    const jobAfterA = state.store?.jobs[0];
    if (!jobAfterA) throw new Error("expected job after run A");

    await finalizeAlertOutcome({
      state,
      job: jobAfterA,
      status: "error",
      error: "second failure",
      startedAt: sharedMs,
      endedAt: sharedMs,
      taskRunId: taskRunIdB,
    });
    expect(pendingAlerts).toHaveLength(2);

    // Settle A first (in-order).
    pendingAlerts[0]!.resolve();
    // A must not settle job state because B owns the slot (lastFailureAlertTaskRunId = taskRunIdB).
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(
        readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(store.storePath),
          jobId: job.id,
          limit: 5,
        }).entries.find((e) => e.runAtMs === sharedMs)?.failureNotificationDelivery?.status,
      ).toBeDefined(),
    );

    // Job state still shows B's pending "unknown" (A was blocked by taskRunId mismatch).
    expect(state.store?.jobs[0]?.state.lastFailureAlertTaskRunId).toBe(taskRunIdB);
    expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");

    // Settle B.
    pendingAlerts[1]!.resolve();
    await vi.waitFor(() =>
      expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered"),
    );
    expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
  });

  it("redacts credentials in a transport rejection before persisting the error", async () => {
    // A misbehaving alert transport can embed credentials in its rejection
    // message. The cron service must scrub them before writing to job state
    // and run history so secrets never reach the protocol surface.
    const secretValue = "tok_live_SUPERSECRETCREDENTIAL";
    registerSecretValueForRedaction(secretValue);
    // Register cleanup regardless of outcome to avoid leaking into sibling tests.
    try {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-08-01T16:30:00.000Z");
      const job = createAlertJob({ id: "failure-alert-redaction", dueAt });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const rawError = `Webhook rejected: Authorization: Bearer ${secretValue}`;
      const state = createAlertState({
        storePath: store.storePath,
        nowMs: () => dueAt + 10,
        sendCronFailureAlert: async () => {
          throw new Error(rawError);
        },
      });
      const taskRunId = `${createCronExecutionId(job.id, dueAt)}:${randomUUID()}`;
      await finalizeAlertOutcome({
        state,
        job,
        status: "error",
        error: "provider unavailable",
        startedAt: dueAt,
        endedAt: dueAt + 10,
        taskRunId,
      });

      await vi.waitFor(() =>
        expect(state.store?.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe(
          "not-delivered",
        ),
      );

      const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
      const persistedError = persisted?.lastFailureNotificationDeliveryError ?? "";

      // The raw secret must not appear in the stored error.
      expect(persistedError).not.toContain(secretValue);
      // The error must still be informative (contains the non-secret parts).
      expect(persistedError).toContain("Webhook rejected");

      const history = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(store.storePath),
        jobId: job.id,
        limit: 5,
      });
      const historyError = history.entries[0]?.failureNotificationDelivery?.error ?? "";
      expect(historyError).not.toContain(secretValue);
      expect(historyError).toContain("Webhook rejected");
    } finally {
      resetSecretRedactionRegistryForTest();
    }
  });
});
