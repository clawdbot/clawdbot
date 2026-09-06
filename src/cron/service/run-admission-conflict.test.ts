import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronJobsStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  isCronRunReceiptOwnerStale,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import { start, stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  cleanupQueuedCronRunReservations,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-admission-conflict-" });

function claimReceipt(storePath: string, job: ReturnType<typeof createDueIsolatedJob>, at: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "main",
    startedAtMs: at,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "main",
    }),
  );
}

it("recovers an ownerless queued lease on a live sibling without restart", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T15:30:00.000Z");
  const job = createDueIsolatedJob({ id: "queued-owner-exit", nowMs: now, nextRunAtMs: now });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const owner = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(owner);
  const [reserved] = await persistQueuedCronRunReservations({
    state: owner,
    candidates: [job],
    reservedAtMs: now,
  });
  if (!reserved) {
    throw new Error("expected durable reservation");
  }
  // Simulate process exit after the atomic queued-marker/receipt commit.
  releaseLocalCronRunReceiptOwnership(reserved.runReceipt);

  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const sibling = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now + 1,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
  });
  await onTimer(sibling);

  expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
    lastRunStatus: "ok",
  });
  expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
  stop(owner);
  stop(sibling);
});

it("recovers a dead running owner on timer refresh without an admission conflict", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T15:45:00.000Z");
  const job = createDueIsolatedJob({ id: "running-owner-exit", nowMs: now, nextRunAtMs: now });
  job.state.runningAtMs = now;
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const receipt = claimReceipt(store.storePath, job, now);
  releaseLocalCronRunReceiptOwnership(receipt);
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const sibling = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now + 1,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
  });

  await onTimer(sibling);

  expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
    lastRunStatus: "error",
  });
  const reclaimed = (await loadCronStore(store.storePath)).jobs[0];
  expect(reclaimed?.enabled).toBe(false);
  expect(reclaimed?.state.runningAtMs).toBeUndefined();
  expect(reclaimed?.state.nextRunAtMs).toBeUndefined();
  expect(reclaimed?.state.startupCatchupAtMs).toBeUndefined();
  // Reclamation must consume the occurrence, not defer a duplicate until the
  // next timer tick or turn it into startup catch-up on a later restart.
  await onTimer(sibling);
  stop(sibling);
  await start(sibling);
  await onTimer(sibling);
  expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  const receiptRows = runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms",
      )
      .all(cronStoreKey(store.storePath), job.id),
  ) as Array<{ status: string }>;
  expect(receiptRows.map((row) => row.status)).toEqual(["interrupted"]);
  stop(sibling);
});

it("preserves foreign state while retrying an unrelated reservation", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T16:00:00.000Z");
  const foreignJob = createDueIsolatedJob({
    id: "foreign-conflict",
    nowMs: now,
    nextRunAtMs: now,
  });
  const pendingJob = createDueIsolatedJob({
    id: "pending-after-conflict",
    nowMs: now,
    nextRunAtMs: now,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [foreignJob, pendingJob] });
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);

  const startedAtMs = now + 1;
  const foreignRunning = structuredClone(foreignJob);
  foreignRunning.state.runningAtMs = startedAtMs;
  foreignRunning.state.lastError = "foreign owner committed";
  const prepared = prepareCronRunReceiptClaim({
    storePath: store.storePath,
    job: foreignRunning,
    agentId: foreignRunning.agentId ?? "main",
    startedAtMs,
  });
  let receipt: ReturnType<typeof claimCronRunReceiptInDatabase> | undefined;
  await saveCronJobsStore(
    store.storePath,
    { version: 1, jobs: [foreignRunning, pendingJob] },
    {
      transactionHooks: {
        beforeWrite: (database) => {
          receipt = claimCronRunReceiptInDatabase({
            database,
            prepared,
            resolveAgentId: (job) => job.agentId ?? "main",
          });
        },
      },
    },
  );

  let reserved: Awaited<ReturnType<typeof persistQueuedCronRunReservations>> = [];
  try {
    reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [foreignJob, pendingJob],
      reservedAtMs: now + 2,
    });

    expect(reserved.map(({ job }) => job.id)).toEqual([pendingJob.id]);
    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === foreignJob.id)?.state).toMatchObject({
      runningAtMs: startedAtMs,
      lastError: "foreign owner committed",
    });
    expect(
      persisted.jobs.find((job) => job.id === foreignJob.id)?.state.queuedAtMs,
    ).toBeUndefined();
    expect(persisted.jobs.find((job) => job.id === pendingJob.id)?.state.queuedAtMs).toBe(now + 2);
  } finally {
    for (const reservation of reserved) {
      finishCronRunReceipt({
        handle: reservation.runReceipt,
        status: "skipped",
        finishedAtMs: now + 3,
      });
    }
    if (receipt) {
      finishCronRunReceipt({
        handle: receipt,
        status: "interrupted",
        finishedAtMs: now + 3,
      });
    }
    stop(state);
  }
});

it("rejects a stale reservation plan after the job already finalized", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T17:00:00.000Z");
  const planned = createDueIsolatedJob({
    id: "finalized-before-reservation",
    nowMs: now,
    nextRunAtMs: now,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [planned] });
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now + 1,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);

  const completed = structuredClone(planned);
  completed.enabled = false;
  completed.updatedAtMs = now + 1;
  completed.state.lastRunAtMs = now;
  completed.state.lastRunStatus = "ok";
  completed.state.lastStatus = "ok";
  completed.state.nextRunAtMs = undefined;
  await saveCronStore(store.storePath, { version: 1, jobs: [completed] });

  expect(
    await persistQueuedCronRunReservations({
      state,
      candidates: [planned],
      reservedAtMs: now + 1,
    }),
  ).toEqual([]);
  const persisted = (await loadCronStore(store.storePath)).jobs[0];
  expect(persisted).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
  expect(persisted?.state.queuedAtMs).toBeUndefined();
  stop(state);
});

it("terminalizes an owned reservation after another gateway deletes the job", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T17:15:00.000Z");
  const job = createDueIsolatedJob({
    id: "deleted-after-reservation",
    nowMs: now,
    nextRunAtMs: now,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  await list(state);
  const [reservation] = await persistQueuedCronRunReservations({
    state,
    candidates: [job],
    reservedAtMs: now,
  });
  if (!reservation) {
    throw new Error("expected reservation");
  }
  const reservationIdentity = reserveQueuedCronRun(state, job.id, now, {
    runReceipt: reservation.runReceipt,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [] });

  await cleanupQueuedCronRunReservations({
    state,
    reservations: [{ jobId: job.id, reservationIdentity }],
  });

  const receipt = runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(reservation.runReceipt.receiptId),
  ) as { status: string } | undefined;
  expect(receipt?.status).toBe("skipped");
  stop(state);
});

it("retires a reservation when its row disappears during the post-commit reload", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T17:30:00.000Z");
  const job = createDueIsolatedJob({
    id: "deleted-during-reservation-reload",
    nowMs: now,
    nextRunAtMs: now,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: store.storePath,
    log: noopLogger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  await list(state);
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TEMP TRIGGER delete_reserved_job_before_reload
    AFTER UPDATE OF state_json ON cron_jobs
    WHEN NEW.job_id = '${job.id}' AND json_extract(NEW.state_json, '$.queuedAtMs') IS NOT NULL
    BEGIN
      DELETE FROM cron_jobs WHERE store_key = NEW.store_key AND job_id = NEW.job_id;
    END;
  `);

  try {
    const reservations = await persistQueuedCronRunReservations({
      state,
      candidates: [job],
      reservedAtMs: now,
    });

    expect(reservations).toEqual([]);
    const receipt = database
      .prepare(
        "SELECT receipt_id AS receiptId, status FROM cron_run_receipts WHERE store_key = ? AND job_id = ?",
      )
      .get(cronStoreKey(store.storePath), job.id) as
      | { receiptId: string; status: string }
      | undefined;
    expect(receipt?.status).toBe("skipped");
    expect(
      isCronRunReceiptOwnerStale({
        receiptId: receipt!.receiptId,
        storeKey: cronStoreKey(store.storePath),
        jobId: job.id,
        configRevision: "unused",
        agentId: job.agentId ?? "main",
        ownerPid: process.pid,
        ownerStartTime: null,
        startedAtMs: now,
      }),
    ).toBe(true);
  } finally {
    database.exec("DROP TRIGGER IF EXISTS delete_reserved_job_before_reload");
    stop(state);
  }
});
