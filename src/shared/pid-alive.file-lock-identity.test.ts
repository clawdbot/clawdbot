// Real-host coverage for the file-lock process identity contract. Everything
// here runs unmocked against the platform the suite is executing on, so the
// Windows CI lane is what proves the win32 branch rather than a mocked dispatch.
import { describe, expect, it } from "vitest";
import { setupCronServiceSuite } from "../cron/service.test-harness.js";
import { saveCronStore } from "../cron/store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../cron/store/run-receipt-store.js";
import type { CronJob } from "../cron/types.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { getFileLockProcessStartTime } from "./pid-alive.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-file-lock-identity-" });

// PIDs are 32-bit on the supported platforms, so this can never be allocated.
const UNALLOCATABLE_PID = 2_147_483_647;

function makeJob(id: string): CronJob {
  return {
    id,
    agentId: "main",
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

describe("file-lock process identity on the running platform", () => {
  it("resolves a start identity for the live process", () => {
    // Every platform OpenClaw supports must answer here. Returning null is what
    // made the Windows cron durable fence throw on every timer tick.
    expect(getFileLockProcessStartTime(process.pid)).toBeTypeOf("number");
    expect(getFileLockProcessStartTime(process.pid)).toBeGreaterThan(0);
  });

  it("stays stable across repeated probes so a live owner never looks recycled", () => {
    expect(getFileLockProcessStartTime(process.pid)).toBe(getFileLockProcessStartTime(process.pid));
  });

  it("reports no identity for an unallocatable PID so reuse still fails closed", () => {
    expect(getFileLockProcessStartTime(UNALLOCATABLE_PID)).toBeNull();
    expect(getFileLockProcessStartTime(0)).toBeNull();
  });

  it("resolves node-worker identity on the real host", () => {
    const identity = requireNodeWorkerProcessIdentity(process.pid);

    expect(identity.pid).toBe(process.pid);
    expect(identity.startTime).toBeTypeOf("number");
    expect(inspectNodeWorkerProcessIdentity(identity)).toBe("live");
    expect(inspectNodeWorkerProcessIdentity({ pid: process.pid, startTime: 1 })).toBe("reused");
  });

  it("lets a cron run acquire its durable fence and persist the owning identity", async () => {
    const { storePath } = await makeStorePath();
    const job = makeJob("durable-fence");
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    // The reported failure is this call throwing "cron run cannot acquire a
    // durable fence without process start identity" before it reaches SQLite.
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "main",
      startedAtMs: 100,
    });
    expect(prepared.handle.ownerStartTime).toBe(getFileLockProcessStartTime(process.pid));

    const claimed = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        prepared,
        resolveAgentId: () => "main",
      }),
    );

    try {
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            `SELECT status, owner_pid AS ownerPid, owner_start_time AS ownerStartTime
               FROM cron_run_receipts WHERE receipt_id = ?`,
          )
          .get(claimed.receiptId),
      ).toEqual({
        status: "running",
        ownerPid: process.pid,
        ownerStartTime: getFileLockProcessStartTime(process.pid),
      });
    } finally {
      // This suite shares core state and its harness clears cron jobs and files,
      // not cron_run_receipts or the module-global owned-receipt set. Finishing
      // the receipt clears both, so a later test cannot inherit a running row.
      finishCronRunReceipt({ handle: claimed, status: "ok", finishedAtMs: 101 });
    }

    expect(
      openOpenClawStateDatabase()
        .db.prepare(`SELECT status FROM cron_run_receipts WHERE receipt_id = ?`)
        .get(claimed.receiptId),
    ).toEqual({ status: "ok" });
  });
});
