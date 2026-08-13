import { describe, expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  assertCronRunReceiptCurrent,
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-receipt-" });

function makeJob(id: string, agentId = "alpha"): CronJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

function claim(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId!,
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId!,
    }),
  );
}

function receipts(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT receipt_id AS receiptId, status, agent_id AS agentId,
              started_at_ms AS startedAtMs, error_text AS error
         FROM cron_run_receipts
        WHERE store_key = ? AND job_id = ?
        ORDER BY started_at_ms DESC, receipt_id DESC`,
    )
    .all(cronStoreKey(storePath), jobId) as Array<{
    receiptId: string;
    status: string;
    agentId: string;
    startedAtMs: number;
    error: string | null;
  }>;
}

describe("cron run receipt store", () => {
  it("lazily creates receipt storage for direct transactional lookups", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("lazy-lookup");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    openOpenClawStateDatabase().db.exec("DROP TABLE cron_run_receipts");

    expect(
      runOpenClawStateWriteTransaction(({ db }) =>
        findActiveCronRunReceiptInDatabase({ database: db, storePath, jobId: job.id }),
      ),
    ).toBeUndefined();
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_receipts'",
        )
        .get(),
    ).toEqual({ name: "cron_run_receipts" });
  });

  it("records one durable active run and rejects an overlapping claimant", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("overlap");
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const first = claim(storePath, job, 100);

    expect(() => claim(storePath, job, 101)).toThrow(CronRunReceiptConflictError);
    expect(receipts(storePath, job.id)).toMatchObject([
      { receiptId: first.receiptId, status: "running", startedAtMs: 100 },
    ]);

    finishCronRunReceipt({ handle: first, status: "ok", finishedAtMs: 110 });
    const second = claim(storePath, job, 120);
    finishCronRunReceipt({ handle: second, status: "skipped", finishedAtMs: 121 });

    expect(receipts(storePath, job.id).map((receipt) => receipt.status)).toEqual(["skipped", "ok"]);
  });

  it("retires a provably dead process claim before admitting its successor", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("restart");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const abandoned = claim(storePath, job, 200);
    openOpenClawStateDatabase()
      .db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?")
      .run(2_147_483_647, abandoned.receiptId);

    const replacement = claim(storePath, job, 220);

    expect(replacement.receiptId).not.toBe(abandoned.receiptId);
    expect(receipts(storePath, job.id)).toMatchObject([
      { receiptId: replacement.receiptId, status: "running" },
      { receiptId: abandoned.receiptId, status: "interrupted" },
    ]);
  });

  it("prunes old terminal receipts while preserving the active and 64 newest rows", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("retention");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const finishedReceiptIds: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const handle = claim(storePath, job, 1_000 + index * 2);
      finishedReceiptIds.push(handle.receiptId);
      finishCronRunReceipt({
        handle,
        status: "ok",
        finishedAtMs: 1_001 + index * 2,
      });
    }
    const active = claim(storePath, job, 2_000);

    const retained = receipts(storePath, job.id);
    const retainedIds = new Set(retained.map((receipt) => receipt.receiptId));
    expect(retained).toHaveLength(65);
    expect(retained).toContainEqual(
      expect.objectContaining({
        receiptId: active.receiptId,
        status: "running",
      }),
    );
    for (const receiptId of finishedReceiptIds.slice(0, 6)) {
      expect(retainedIds.has(receiptId)).toBe(false);
    }
    for (const receiptId of finishedReceiptIds.slice(-64)) {
      expect(retainedIds.has(receiptId)).toBe(true);
    }

    finishCronRunReceipt({ handle: active, status: "skipped", finishedAtMs: 2_001 });
  });

  it("rejects a live run after its durable owner revision changes", async () => {
    const { storePath } = await makeStorePath();
    const admitted = makeJob("owner-change", "alpha");
    await saveCronStore(storePath, { version: 1, jobs: [admitted] });
    const receipt = claim(storePath, admitted, 300);
    const reassigned = { ...admitted, agentId: "beta", updatedAtMs: 2 };
    await saveCronStore(storePath, { version: 1, jobs: [reassigned] });

    expect(() =>
      assertCronRunReceiptCurrent({
        handle: receipt,
        resolveAgentId: (job) => job.agentId!,
      }),
    ).toThrow(CronRunReceiptRevisionError);

    finishCronRunReceipt({
      handle: receipt,
      status: "superseded",
      finishedAtMs: 310,
      error: "owner changed",
    });
    expect(receipts(storePath, admitted.id)[0]).toMatchObject({
      status: "superseded",
      agentId: "alpha",
      error: "owner changed",
    });
  });
});
