import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import { saveCronJobsStoreWithTransactionHooks } from "../store/transaction-hooks.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { persistQueuedCronRunReservations } from "./run-admission.js";
import { createCronServiceState } from "./state.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-admission-conflict-" });

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
  await saveCronJobsStoreWithTransactionHooks(
    store.storePath,
    { version: 1, jobs: [foreignRunning, pendingJob] },
    undefined,
    {
      beforeWrite: (database) => {
        receipt = claimCronRunReceiptInDatabase({
          database,
          prepared,
          resolveAgentId: (job) => job.agentId ?? "main",
        });
      },
    },
  );

  try {
    const reserved = await persistQueuedCronRunReservations({
      state,
      jobIds: [foreignJob.id, pendingJob.id],
      reservedAtMs: now + 2,
    });

    expect(reserved.map((job) => job.id)).toEqual([pendingJob.id]);
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
