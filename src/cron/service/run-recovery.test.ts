import { describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import { saveCronJobsStoreWithTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob } from "../types.js";
import { proposeCronRunRecovery, recoverCronRunProposal } from "./run-recovery.js";
import { createCronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { tryCreateCronTaskRunHandle, tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";

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
      publicRunId: receipt.receiptId,
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
