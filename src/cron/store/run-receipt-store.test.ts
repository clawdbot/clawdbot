import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import * as pidAlive from "../../shared/pid-alive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { proposeCronRunRecovery, recoverCronRunProposal } from "../service/run-recovery.js";
import { createCronServiceState } from "../service/state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  assertCronRunReceiptCurrent,
  activateCronRunReceiptInDatabase,
  bindCronRunReceiptExecution,
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "./run-receipt-store.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-receipt-" });

afterEach(() => vi.restoreAllMocks());

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

function makeForeignOwner(handle: CronRunReceiptHandle) {
  const ownerPid = 2_147_483_646;
  openOpenClawStateDatabase()
    .db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?")
    .run(ownerPid, handle.receiptId);
  releaseLocalCronRunReceiptOwnership(handle);
  vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
  const getStartTime = pidAlive.getFileLockProcessStartTime;
  const startTimeProbe = vi
    .spyOn(pidAlive, "getFileLockProcessStartTime")
    .mockImplementation((pid) => (pid === ownerPid ? handle.ownerStartTime : getStartTime(pid)));
  return { handle: { ...handle, ownerPid }, startTimeProbe, getStartTime };
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

  it.each(["dead", "reused", "unreadable"] as const)(
    "retires a stale %s process claim before admitting its successor",
    async (owner) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob(`restart-${owner}`);
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const abandoned = claim(storePath, job, startedAtMs);
      if (owner === "dead") {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?")
          .run(2_147_483_647, abandoned.receiptId);
        releaseLocalCronRunReceiptOwnership(abandoned);
      } else {
        const foreign = makeForeignOwner(abandoned);
        foreign.startTimeProbe.mockImplementation((pid) =>
          pid === foreign.handle.ownerPid
            ? owner === "unreadable"
              ? null
              : abandoned.ownerStartTime! + 1
            : foreign.getStartTime(pid),
        );
      }
      vi.setSystemTime(startedAtMs + (owner === "unreadable" ? 2 * 60 * 60_000 : 0) + 1);

      const replacement = claim(storePath, job, Date.now());

      expect(replacement.receiptId).not.toBe(abandoned.receiptId);
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: replacement.receiptId, status: "running" },
        { receiptId: abandoned.receiptId, status: "interrupted" },
      ]);
      finishCronRunReceipt({ handle: replacement, status: "ok", finishedAtMs: Date.now() + 1 });
    },
  );

  it("recovers an unreadable foreign owner only after the stuck-run horizon", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("unreadable-owner");
    job.state.runningAtMs = startedAtMs;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const foreign = makeForeignOwner(claim(storePath, job, startedAtMs));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const proposal = proposeCronRunRecovery(state, job.id, undefined, startedAtMs);
    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "live" });

    foreign.startTimeProbe.mockImplementation((pid) =>
      pid === foreign.handle.ownerPid ? null : foreign.getStartTime(pid),
    );
    vi.setSystemTime(startedAtMs + 2 * 60 * 60_000);
    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "live" });
    expect(() => claim(storePath, job, Date.now())).toThrow(CronRunReceiptConflictError);
    vi.setSystemTime(Date.now() + 1);

    expect(recoverCronRunProposal(state, proposal)).toMatchObject({ kind: "repaired" });
    const recovered = (await loadCronStore(storePath)).jobs[0]!;
    expect(recovered.state).toMatchObject({ lastRunStatus: "error" });
    expect(recovered.state.runningAtMs).toBeUndefined();
    expect(receipts(storePath, job.id)).toMatchObject([
      { receiptId: foreign.handle.receiptId, status: "interrupted" },
    ]);
    expect(() =>
      assertCronRunReceiptCurrent({ handle: foreign.handle, resolveAgentId: () => job.agentId! }),
    ).toThrow(CronRunReceiptRevisionError);
    const successor = claim(storePath, recovered, Date.now());
    finishCronRunReceipt({ handle: successor, status: "ok", finishedAtMs: Date.now() + 1 });
  });

  it.each(["local", "foreign"] as const)(
    "keeps a verified %s owner fenced beyond the stuck-run horizon",
    async (owner) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob(`verified-${owner}`);
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const claimed = claim(storePath, job, startedAtMs);
      const handle = owner === "foreign" ? makeForeignOwner(claimed).handle : claimed;
      vi.setSystemTime(startedAtMs + 3 * 60 * 60_000);

      expect(() => claim(storePath, job, Date.now())).toThrow(CronRunReceiptConflictError);
      expect(receipts(storePath, job.id)).toMatchObject([
        { receiptId: handle.receiptId, status: "running" },
      ]);
      finishCronRunReceipt({ handle, status: "ok", finishedAtMs: Date.now() });
    },
  );

  it("invalidates stale-owner adjudication when a queued receipt starts running", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("unreadable-queued-owner");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const foreign = makeForeignOwner(claim(storePath, job, startedAtMs));
    foreign.startTimeProbe.mockImplementation((pid) =>
      pid === foreign.handle.ownerPid ? null : foreign.getStartTime(pid),
    );
    vi.setSystemTime(startedAtMs + 2 * 60 * 60_000 + 1);
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: job.agentId!,
      startedAtMs: Date.now(),
    });
    const running = runOpenClawStateWriteTransaction(({ db }) =>
      activateCronRunReceiptInDatabase({
        database: db,
        handle: foreign.handle,
        startedAtMs: Date.now(),
        resolveAgentId: () => job.agentId!,
      }),
    );

    expect(() =>
      runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabase({
          database: db,
          prepared,
          resolveAgentId: () => job.agentId!,
        }),
      ),
    ).toThrow(CronRunReceiptConflictError);
    expect(receipts(storePath, job.id)).toMatchObject([
      { receiptId: running.receiptId, status: "running", startedAtMs: Date.now() },
    ]);
    finishCronRunReceipt({ handle: running, status: "ok", finishedAtMs: Date.now() + 1 });
  });

  it("rejects a delayed binding after a successor replaces its exact owner", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("stale-binding");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const abandoned = claim(storePath, job, 230);
    openOpenClawStateDatabase()
      .db.prepare("UPDATE cron_run_receipts SET owner_pid = ? WHERE receipt_id = ?")
      .run(2_147_483_647, abandoned.receiptId);
    const replacement = claim(storePath, job, 240);
    const admitted: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance-stale", runId: "run-stale" },
      executionIdentityToken: createExecutionIdentityAdmissionToken("run-stale", {
        contextId: "context-stale",
        executionId: "execution-stale",
      }),
    };

    expect(bindCronRunReceiptExecution({ admitted, handle: abandoned })).toBe("missing");
    expect(bindCronRunReceiptExecution({ admitted, handle: replacement })).toBe("bound");
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          `SELECT owner_id
           FROM execution_owner_lifecycle_bindings
           WHERE owner_kind = 'cron'`,
        )
        .all(),
    ).toEqual([{ owner_id: replacement.receiptId }]);

    finishCronRunReceipt({ handle: replacement, status: "ok", finishedAtMs: 250 });
  });

  it("prunes old terminal receipts while preserving the active and 64 newest rows", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("retention");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const admitted: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance-retention", runId: "run-retention" },
      executionIdentityToken: createExecutionIdentityAdmissionToken("run-retention", {
        contextId: "context-retention",
        executionId: "execution-retention",
      }),
    };
    const finishedReceiptIds: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const handle = claim(storePath, job, 1_000 + index * 2);
      finishedReceiptIds.push(handle.receiptId);
      if (index === 0 || index === 69) {
        expect(bindCronRunReceiptExecution({ admitted, handle })).toBe("bound");
      }
      finishCronRunReceipt({
        handle,
        status: "ok",
        finishedAtMs: 1_001 + index * 2,
      });
    }
    const active = claim(storePath, job, 2_000);
    expect(bindCronRunReceiptExecution({ admitted, handle: active })).toBe("bound");

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
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          `SELECT binding.owner_id
           FROM execution_owner_lifecycle_bindings AS binding
           JOIN cron_run_receipts AS receipt ON receipt.receipt_id = binding.owner_id
           WHERE binding.owner_kind = 'cron' AND receipt.job_id = ?
           ORDER BY owner_id`,
        )
        .all(job.id),
    ).toEqual(
      [active.receiptId, finishedReceiptIds.at(-1)]
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? ""))
        .map((owner_id) => ({ owner_id })),
    );

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
