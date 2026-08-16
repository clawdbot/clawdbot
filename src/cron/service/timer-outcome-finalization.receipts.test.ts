import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-finalization-receipts-" });

function claimReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "main",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "main",
    }),
  );
}

describe("cron outcome receipt finalization", () => {
  it("emits only committed authoritative outcomes after a rejected batch attempt", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:04:59.250Z");
    const stale = createDueIsolatedJob({
      id: "rejected-event",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    const current = createDueIsolatedJob({
      id: "committed-event",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    stale.state.runningAtMs = startedAt;
    current.state.runningAtMs = startedAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [stale, current] });
    const staleReceipt = claimReceipt(store.storePath, stale, startedAt);
    const currentReceipt = claimReceipt(store.storePath, current, startedAt);
    finishCronRunReceipt({
      handle: staleReceipt,
      status: "superseded",
      finishedAtMs: startedAt + 1,
    });
    const edited = await loadCronStore(store.storePath);
    edited.jobs.find((job) => job.id === current.id)!.name = "authoritative edited name";
    await saveCronStore(store.storePath, edited);
    const events: Array<{ action: string; jobId: string; job?: CronJob }> = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startedAt + 2,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => events.push(event),
    });

    await finalizeCompletedCronRunOutcomes(state, [
      {
        jobId: stale.id,
        job: stale,
        activeJobMarker: markCronJobActive(stale.id),
        runReceipt: staleReceipt,
        status: "ok",
        startedAt,
        endedAt: startedAt + 2,
      },
      {
        jobId: current.id,
        job: current,
        activeJobMarker: markCronJobActive(current.id),
        runReceipt: currentReceipt,
        status: "ok",
        startedAt,
        endedAt: startedAt + 2,
      },
    ]);

    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        jobId: current.id,
        job: expect.objectContaining({ name: "authoritative edited name" }),
      }),
    ]);
  });

  it("records a non-firing scheduled trigger as a skipped receipt", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:59.500Z");
    const job = createDueIsolatedJob({
      id: "scheduled-trigger-not-fired",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    job.trigger = { script: "return false" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn(async () => ({ kind: "evaluated" as const, fire: false })),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt?.status).toBe("skipped");
  });

  it("schedules an unrelated job missing nextRunAtMs after batch finalization", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:00.000Z");
    const completed = createDueIsolatedJob({
      id: "completed-batch-job",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    completed.state.runningAtMs = startedAt;
    const imported = createDueIsolatedJob({
      id: "imported-without-next-run",
      nowMs: startedAt,
      nextRunAtMs: startedAt + 60_000,
    });
    imported.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, imported] });
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startedAt + 1,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });

    await finalizeCompletedCronRunOutcomes(state, [
      {
        jobId: completed.id,
        job: completed,
        activeJobMarker: markCronJobActive(completed.id),
        runReceipt: receipt,
        status: "ok",
        startedAt,
        endedAt: startedAt + 1,
      },
    ]);

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === imported.id)?.state.nextRunAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("publishes the committed outcome before best-effort maintenance fails", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.000Z");
    const completed = createDueIsolatedJob({
      id: "published-before-maintenance",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    completed.state.runningAtMs = startedAt;
    const sibling = createDueIsolatedJob({
      id: "maintenance-write-fails",
      nowMs: startedAt,
      nextRunAtMs: startedAt + 60_000,
    });
    sibling.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, sibling] });
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const events: Array<{ action: string; jobId: string }> = [];
    const warn = vi.fn();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: { ...noopLogger, warn },
      nowMs: () => startedAt + 1,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => events.push(event),
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_post_finalization_maintenance
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.job_id = '${sibling.id}'
      BEGIN
        SELECT RAISE(ABORT, 'maintenance unavailable');
      END;
    `);

    try {
      await expect(
        finalizeCompletedCronRunOutcomes(state, [
          {
            jobId: completed.id,
            job: completed,
            activeJobMarker: markCronJobActive(completed.id),
            runReceipt: receipt,
            status: "ok",
            startedAt,
            endedAt: startedAt + 1,
          },
        ]),
      ).resolves.toHaveLength(1);

      expect(events).toContainEqual(
        expect.objectContaining({ action: "finished", jobId: completed.id }),
      );
      const persistedReceipt = database
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId) as { status: string } | undefined;
      expect(persistedReceipt?.status).toBe("ok");
      expect(warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("maintenance unavailable") },
        "cron: post-finalization schedule maintenance failed",
      );
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_post_finalization_maintenance");
    }
  });
});
