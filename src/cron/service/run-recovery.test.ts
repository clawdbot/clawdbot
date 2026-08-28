import { describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  inspectActiveCronRunReceipt,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import { saveCronJobsStoreWithTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import {
  proposeCronRunRecovery,
  recomputeUnownedCronSchedules,
  recoverCronRunProposal,
} from "./run-recovery.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import {
  tryCreateCronTaskRunHandle,
  tryFinishCronTaskRun,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";

function tryCreateCronTaskRun(
  params: Parameters<typeof tryCreateCronTaskRunHandle>[0],
): string | undefined {
  return tryCreateCronTaskRunHandle(params)?.runId;
}

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-recovery-" });

function makeJob(id: string, startedAtMs: number): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: startedAtMs - 1,
    updatedAtMs: startedAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
    state: { runningAtMs: startedAtMs, nextRunAtMs: startedAtMs },
  };
}

type RecoveryStateOverrides = Partial<
  Pick<
    Parameters<typeof createCronServiceState>[0],
    "cronConfig" | "enqueueSystemEvent" | "requestHeartbeat" | "sendCronFailureAlert"
  >
>;

function makeState(storePath: string, nowMs: number, overrides: RecoveryStateOverrides = {}) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

function claimReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "alpha",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "alpha",
    }),
  );
}

async function commitCompletedJob(params: {
  storePath: string;
  jobs: CronJob[];
  receipt: CronRunReceiptHandle;
  finishedAtMs: number;
}) {
  await saveCronJobsStoreWithTransactionHooks(
    params.storePath,
    { version: 1, jobs: params.jobs },
    undefined,
    {
      afterWrite: (database) => {
        finishCronRunReceiptInDatabase({
          database,
          handle: params.receipt,
          status: "ok",
          finishedAtMs: params.finishedAtMs,
        });
      },
    },
  );
  releaseLocalCronRunReceiptOwnership(params.receipt);
}

describe("atomic cron run recovery", () => {
  it("rolls back receipt retirement when the pending recovery slot cannot commit", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("recovery-rollback", startedAtMs);
    job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
    job.deleteAfterRun = true;
    job.delivery = { mode: "none" };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);
    const state = makeState(storePath, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    const database = openOpenClawStateDatabase().db;
    // Fail the row write after receipt retirement, inside the real transaction.
    database.exec(`
      CREATE TEMP TRIGGER reject_pending_recovery
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.job_id = 'recovery-rollback'
        AND json_extract(NEW.state_json, '$.startupCatchupAtMs') IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'pending recovery unavailable');
      END;
    `);
    try {
      expect(() => recoverCronRunProposal(state, proposal, "startup")).toThrow(
        "pending recovery unavailable",
      );
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.receiptId).toBe(
        receipt.receiptId,
      );
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.runningAtMs).toBe(startedAtMs);
      expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
      expect(persisted?.state.lastRunStatus).toBeUndefined();
    } finally {
      database.exec("DROP TRIGGER reject_pending_recovery");
    }
    expect(recoverCronRunProposal(state, proposal, "startup")).toMatchObject({ kind: "repaired" });
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
    const pending = (await loadCronStore(storePath)).jobs[0];
    expect(pending?.state).toMatchObject({
      nextRunAtMs: startedAtMs,
      startupCatchupAtMs: startedAtMs,
      consecutiveErrors: 1,
    });
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
    for (let restart = 0; restart < 3; restart += 1) {
      const next = createCronServiceState({ ...state.deps, runCommandJob });
      try {
        await start(next);
        expect(runCommandJob).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
      } finally {
        stop(next);
      }
    }
  });

  it.each([
    { terminal: undefined, deleteAfterRun: false },
    { terminal: undefined, deleteAfterRun: true },
    { terminal: "ok", deleteAfterRun: false },
    { terminal: "ok", deleteAfterRun: true },
    { terminal: "error", deleteAfterRun: false },
    { terminal: "error", deleteAfterRun: true },
    { terminal: "skipped", deleteAfterRun: false },
    { terminal: "skipped", deleteAfterRun: true },
    { terminal: undefined, deleteAfterRun: true, result: "error" },
  ] as const)(
    "recovers only a nonterminal one-shot across three restarts (terminal=$terminal, deleteAfterRun=$deleteAfterRun, result=$result)",
    async (testCase) => {
      const { terminal, deleteAfterRun } = testCase;
      const recoveredStatus = testCase.result ?? "ok";
      const finalStatus = terminal ?? recoveredStatus;
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now() - (deleteAfterRun ? 365 * 24 * 60 * 60_000 : 0);
      const job = makeJob("restart-one-shot", startedAtMs);
      job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
      job.deleteAfterRun = deleteAfterRun;
      job.delivery = { mode: "none" };
      // A recovered execution can itself die after writing its terminal task.
      job.state.startupCatchupAtMs = startedAtMs;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const original = makeState(storePath, startedAtMs);
      const receipt = claimReceipt(storePath, job, startedAtMs);
      const taskRunId = tryCreateCronTaskRun({
        state: original,
        job,
        startedAt: startedAtMs,
        runReceipt: receipt,
      });
      expect(taskRunId).toBeDefined();
      if (terminal) {
        tryFinishCronTaskRun(original, {
          taskRunId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: terminal,
            completionStatus: terminal === "ok" ? "succeeded" : "failed",
            deliveryStatus: "not-requested",
            error: terminal === "error" ? "command failed" : undefined,
            runAtMs: startedAtMs,
            durationMs: 1,
          },
        });
      }
      // Lose the process after admission (and optional terminal ledger write),
      // before the job row and receipt have settled.
      releaseLocalCronRunReceiptOwnership(receipt);
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => ({
        status: recoveredStatus,
        summary: "recovered",
        error: recoveredStatus === "error" ? "command failed" : undefined,
      }));
      const onEvent = vi.fn();
      for (let restart = 0; restart < 3; restart += 1) {
        const state = createCronServiceState({
          ...makeState(storePath, Date.now()).deps,
          runCommandJob,
          onEvent,
        });
        try {
          await start(state);
          expect(runCommandJob).toHaveBeenCalledTimes(terminal ? 0 : 1);
          const persisted = (await loadCronStore(storePath)).jobs.find(
            (entry) => entry.id === job.id,
          );
          if (deleteAfterRun && finalStatus === "ok") {
            expect(persisted).toBeUndefined();
          } else {
            expect(persisted).toMatchObject({
              enabled: false,
              state: { lastRunStatus: finalStatus },
            });
            expect(persisted?.state.runningAtMs).toBeUndefined();
            expect(persisted?.state.nextRunAtMs).toBeUndefined();
            expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
          }
          expect(
            onEvent.mock.calls
              .filter(([event]) => event.action === "finished")
              .map(([event]) => event.status),
          ).toEqual(terminal ? [] : ["error", recoveredStatus]);
        } finally {
          stop(state);
        }
      }
    },
  );

  it.each(["repair", "agent-deferral", "overflow-deferral"] as const)(
    "keeps one-shot recovery durable across restart after %s",
    async (phase) => {
      const { storePath } = await makeStorePath();
      const nowMs = Date.now();
      const startedAtMs = nowMs - 365 * 24 * 60 * 60_000;
      const job = makeJob("pending-one-shot", startedAtMs);
      job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
      job.deleteAfterRun = true;
      job.delivery = { mode: "none" };
      if (phase === "agent-deferral") {
        job.payload = { kind: "agentTurn", message: "recover pending work" };
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAtMs);
      const original = makeState(storePath, nowMs);
      tryCreateCronTaskRun({ state: original, job, startedAt: startedAtMs, runReceipt: receipt });
      releaseLocalCronRunReceiptOwnership(receipt);
      const runJob = vi.fn(async () => ({ status: "ok" as const }));
      const freshState = () =>
        createCronServiceState({
          ...original.deps,
          nowMs: Date.now,
          runCommandJob: runJob,
          runIsolatedAgentJob: runJob,
          ...(phase === "overflow-deferral" ? { maxMissedJobsPerRestart: 0 } : {}),
        });
      const first = freshState();
      try {
        if (phase === "repair") {
          const proposal = proposeCronRunRecovery(first, job.id, undefined, startedAtMs);
          expect(recoverCronRunProposal(first, proposal, "startup")).toMatchObject({
            kind: "repaired",
          });
          expect(recoverCronRunProposal(first, proposal, "startup")).toMatchObject({
            kind: "superseded",
          });
          recomputeUnownedCronSchedules(first, { recomputeExpired: true });
        } else {
          await start(first);
        }
        expect(runJob).not.toHaveBeenCalled();
        const pending = (await loadCronStore(storePath)).jobs[0];
        expect(pending).toMatchObject({ enabled: true, state: { consecutiveErrors: 1 } });
        const dueAt =
          phase === "repair" ? startedAtMs : nowMs + (phase === "agent-deferral" ? 120_000 : 5_000);
        expect(pending?.state.nextRunAtMs).toBe(dueAt);
        expect(pending?.state.startupCatchupAtMs).toBe(dueAt);
        expect(pending?.state.runningAtMs).toBeUndefined();
      } finally {
        stop(first);
      }
      if (phase !== "repair") {
        for (let restart = 0; restart < 3; restart += 1) {
          await vi.advanceTimersByTimeAsync(1);
          const pendingState = freshState();
          try {
            await start(pendingState);
            const pending = (await loadCronStore(storePath)).jobs[0];
            const dueAt = nowMs + (phase === "agent-deferral" ? 120_000 : 5_000);
            expect(pending).toMatchObject({
              enabled: true,
              state: { nextRunAtMs: dueAt, startupCatchupAtMs: dueAt, consecutiveErrors: 1 },
            });
            expect(runJob).not.toHaveBeenCalled();
          } finally {
            stop(pendingState);
          }
        }
      }
      const second = freshState();
      try {
        await start(second);
        if (phase !== "repair") {
          expect(runJob).not.toHaveBeenCalled();
          const delay = nowMs + (phase === "agent-deferral" ? 120_000 : 5_000) - Date.now();
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(runJob).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await vi.waitFor(async () =>
            expect((await loadCronStore(storePath)).jobs).toHaveLength(0),
          );
        }
        expect(runJob).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
      } finally {
        stop(second);
      }
      const third = freshState();
      try {
        await start(third);
        expect(runJob).toHaveBeenCalledOnce();
      } finally {
        stop(third);
      }
    },
  );

  it("retires a stale settling receipt after its marker is already gone", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:15:00.000Z");
    const job = makeJob("markerless-settling-owner-death", startedAtMs);
    delete job.state.runningAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, { jobId: job.id, receipt })).toMatchObject({
      kind: "repaired",
    });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("interrupted");
  });

  it("repairs a matching marker after its observed receipt terminalizes", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:30:00.000Z");
    const job = makeJob("terminalized-before-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    runOpenClawStateWriteTransaction(({ db }) =>
      finishCronRunReceiptInDatabase({
        database: db,
        handle: receipt,
        status: "ok",
        finishedAtMs: startedAtMs + 1,
      }),
    );

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    const persisted = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(persisted?.runningAtMs).toBeUndefined();
    expect(persisted?.lastRunStatus).toBe("error");
    releaseLocalCronRunReceiptOwnership(receipt);
  });

  it("queues a threshold-crossing interrupted-run alert after persistence", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:35:00.000Z");
    const nowMs = startedAtMs + 30_000;
    const job = makeJob("interrupted-threshold-alert", startedAtMs);
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = { after: 2, cooldownMs: 60_000 };
    job.state.consecutiveErrors = 1;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(storePath, nowMs, { sendCronFailureAlert });

    const result = recoverCronRunProposal(state, {
      jobId: job.id,
      runningAtMs: startedAtMs,
    });

    expect(result).toMatchObject({ kind: "repaired" });
    if (result.kind !== "repaired") {
      throw new Error("expected repaired interrupted run");
    }
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    expect(result.notifications).toHaveLength(1);
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      consecutiveErrors: 2,
      lastFailureAlertAtMs: nowMs,
      lastFailureNotificationDeliveryStatus: "unknown",
    });

    runPostPersistCronNotifications(state, result.notifications);
    await vi.waitFor(() => expect(sendCronFailureAlert).toHaveBeenCalledOnce());
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        runAtMs: startedAtMs,
        payload: expect.objectContaining({
          text: expect.stringContaining("failed 2 times"),
        }),
      }),
    );
  });

  it("keeps interrupted-run alerts disabled by failureAlert false", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:36:00.000Z");
    const job = makeJob("interrupted-alert-disabled", startedAtMs);
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = false;
    job.state.consecutiveErrors = 1;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(storePath, startedAtMs + 30_000, { sendCronFailureAlert });

    const result = recoverCronRunProposal(state, {
      jobId: job.id,
      runningAtMs: startedAtMs,
    });

    expect(result).toMatchObject({ kind: "repaired", notifications: [] });
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      consecutiveErrors: 2,
      lastFailureNotificationDeliveryStatus: "not-requested",
    });
  });

  it("keeps only auto-disable notification on the tenth interrupted failure", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:37:00.000Z");
    const nowMs = startedAtMs + 30_000;
    const job = makeJob("interrupted-auto-disable", startedAtMs);
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = { after: 10, cooldownMs: 0 };
    job.state.consecutiveErrors = 9;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(storePath, nowMs, { enqueueSystemEvent, sendCronFailureAlert });

    const result = recoverCronRunProposal(state, {
      jobId: job.id,
      runningAtMs: startedAtMs,
    });

    expect(result).toMatchObject({ kind: "repaired" });
    if (result.kind !== "repaired") {
      throw new Error("expected repaired interrupted run");
    }
    expect(result.notifications).toHaveLength(1);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        consecutiveErrors: 10,
        lastFailureNotificationDeliveryStatus: "not-requested",
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });

    runPostPersistCronNotifications(state, result.notifications);
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("restores a finalized quiet trigger with a skipped receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:45:00.000Z");
    const job = makeJob("quiet-trigger-recovery", startedAtMs);
    job.trigger = { script: "return false" };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      runReceipt: receipt,
    });
    tryFinishCronTaskRunWithoutHistory(state, {
      taskRunId,
      status: "ok",
      endedAt: startedAtMs + 1,
      triggerEval: { fired: false, stateChanged: true, state: { ready: false } },
    });
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    const persisted = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(persisted?.runningAtMs).toBeUndefined();
    expect(persisted?.lastRunAtMs).toBeUndefined();
    expect(persisted?.triggerState).toEqual({ ready: false });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("skipped");
  });

  it("does not restore a prior same-millisecond task for a different receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:50:00.000Z");
    const job = makeJob("same-millisecond-task-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const priorReceipt = claimReceipt(storePath, job, startedAtMs);
    const priorTaskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      runReceipt: priorReceipt,
    });
    tryFinishCronTaskRun(state, {
      taskRunId: priorTaskRunId,
      job,
      event: {
        jobId: job.id,
        action: "finished",
        job,
        status: "ok",
        summary: "prior receipt completed",
        runAtMs: startedAtMs,
        durationMs: 1,
      },
    });
    finishCronRunReceipt({
      handle: priorReceipt,
      status: "ok",
      finishedAtMs: startedAtMs + 1,
    });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: expect.stringContaining("interrupted by gateway restart"),
    });
  });

  it("fails closed for a legacy caller-ID task without exact receipt identity", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:55:00.000Z");
    const job = makeJob("legacy-manual-task-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      publicRunId: "manual:legacy-manual-task-recovery:1",
    });
    tryFinishCronTaskRun(state, {
      taskRunId,
      job,
      event: {
        jobId: job.id,
        action: "finished",
        job,
        status: "ok",
        runId: "manual:legacy-manual-task-recovery:1",
        runAtMs: startedAtMs,
        durationMs: 1,
      },
    });
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: expect.stringContaining("interrupted by gateway restart"),
    });
  });

  it("retires a dead owner receipt after timeout state already finalized", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T11:00:00.000Z");
    const job = makeJob("timeout-settlement-owner-death", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    const completed = structuredClone(job);
    delete completed.state.runningAtMs;
    completed.state.lastRunAtMs = startedAtMs;
    completed.state.lastRunStatus = "ok";
    completed.state.lastStatus = "ok";
    await writeCronStoreSnapshot({ storePath, jobs: [completed] });
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunAtMs: startedAtMs,
      lastRunStatus: "ok",
    });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("interrupted");
  });

  it("reports a foreign queued-to-running conversion for lifecycle monitoring", async () => {
    const { storePath } = await makeStorePath();
    const queuedAtMs = Date.parse("2026-08-13T11:30:00.000Z");
    const job = makeJob("queued-to-running-owner", queuedAtMs);
    delete job.state.runningAtMs;
    job.state.queuedAtMs = queuedAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, queuedAtMs + 1);
    const proposal = proposeCronRunRecovery(state, job.id, queuedAtMs, undefined);
    const running = structuredClone(job);
    delete running.state.queuedAtMs;
    running.state.runningAtMs = queuedAtMs + 1;
    const receipt = claimReceipt(storePath, running, queuedAtMs + 1);
    await writeCronStoreSnapshot({ storePath, jobs: [running] });

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({
      kind: "superseded",
      receipt: { receiptId: receipt.receiptId },
    });
    finishCronRunReceipt({ handle: receipt, status: "interrupted", finishedAtMs: queuedAtMs + 2 });
  });

  it("does not clobber a same-millisecond successor receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T12:00:00.000Z");
    const job = makeJob("same-millisecond-successor", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(storePath, startedAtMs + 30_000);
    const first = claimReceipt(storePath, job, startedAtMs);
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);

    finishCronRunReceipt({
      handle: first,
      status: "interrupted",
      finishedAtMs: startedAtMs + 1,
    });
    const successor = claimReceipt(storePath, job, startedAtMs);

    const result = recoverCronRunProposal(state, proposal);

    expect(result).toMatchObject({
      kind: "superseded",
      receipt: { receiptId: successor.receiptId, startedAtMs },
    });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAtMs);
    const successorRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(successor.receiptId),
    ) as { status: string };
    expect(successorRow.status).toBe("running");
    finishCronRunReceipt({
      handle: successor,
      status: "interrupted",
      finishedAtMs: startedAtMs + 2,
    });
  });

  it("keeps each repaired candidate durable across a partial-pass restart", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T13:00:00.000Z");
    const firstJob = makeJob("partial-first", startedAtMs);
    const secondJob = makeJob("partial-second", startedAtMs + 1);
    await writeCronStoreSnapshot({ storePath, jobs: [firstJob, secondJob] });
    const firstReceipt = claimReceipt(storePath, firstJob, startedAtMs);
    const secondReceipt = claimReceipt(storePath, secondJob, startedAtMs + 1);
    releaseLocalCronRunReceiptOwnership(firstReceipt);
    releaseLocalCronRunReceiptOwnership(secondReceipt);
    const firstState = makeState(storePath, startedAtMs + 30_000);
    const firstProposal = proposeCronRunRecovery(firstState, firstJob.id, undefined, startedAtMs);
    const secondProposal = proposeCronRunRecovery(
      firstState,
      secondJob.id,
      undefined,
      startedAtMs + 1,
    );

    expect(recoverCronRunProposal(firstState, firstProposal)).toMatchObject({ kind: "repaired" });
    const afterFirstRepair = await loadCronStore(storePath);
    const completedSecond = structuredClone(
      afterFirstRepair.jobs.find((entry) => entry.id === secondJob.id)!,
    );
    delete completedSecond.state.runningAtMs;
    completedSecond.state.lastRunAtMs = startedAtMs + 1;
    completedSecond.state.lastRunStatus = "ok";
    completedSecond.state.lastStatus = "ok";
    await commitCompletedJob({
      storePath,
      jobs: afterFirstRepair.jobs.map((entry) =>
        entry.id === completedSecond.id ? completedSecond : entry,
      ),
      receipt: secondReceipt,
      finishedAtMs: startedAtMs + 2_000,
    });

    const restartedState = makeState(storePath, startedAtMs + 31_000);
    expect(recoverCronRunProposal(restartedState, secondProposal)).toEqual({ kind: "superseded" });
    expect(recoverCronRunProposal(restartedState, firstProposal)).toEqual({ kind: "superseded" });
    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs.find((entry) => entry.id === firstJob.id)?.state).toMatchObject({
      lastRunStatus: "error",
    });
    const persistedSecond = persisted.jobs.find((entry) => entry.id === secondJob.id)?.state;
    expect(persistedSecond).toMatchObject({ lastRunStatus: "ok" });
    expect(persistedSecond?.runningAtMs).toBeUndefined();
  });
});
