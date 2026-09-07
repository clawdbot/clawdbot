// A lost in-process queued run must be reclaimed by its own recovery path.
// #139215: outcome-finalization gaps left jobs with a durable queuedAtMs and
// an open receipt owned by the live process; recovery trusted that receipt
// forever (an own-process receipt is never stale) and the job wedged until
// restart, silently skipping every slot in between.
import { describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import {
  claimCronRunReceiptInDatabase,
  inspectActiveCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-lost-queued-" });

describe("lost in-process queued runs", () => {
  it("reclaims the job instead of wedging on its own never-stale receipt (#139215)", async () => {
    const { storePath } = await makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:07.000Z");
    const job: CronJob = {
      id: "lost-queued-run",
      agentId: "alpha",
      name: "lost queued run",
      enabled: true,
      createdAtMs: dueAt - 1,
      updatedAtMs: dueAt - 1,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "command", argv: ["true"] },
      delivery: { mode: "none" },
      // Orphan shape left by a lost run outcome: overdue slot plus the durable
      // queued marker, with no live execution behind it anymore.
      state: { nextRunAtMs: dueAt, queuedAtMs: dueAt },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    // Open receipt owned by THIS process. Recovery's stale check can never
    // fire for it, which is exactly what wedged these jobs before.
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "alpha",
      startedAtMs: dueAt,
    });
    runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({ database: db, prepared, resolveAgentId: () => "alpha" }),
    );
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeDefined();

    let tickNow = dueAt + 1;
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => (tickNow += 1),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob,
      onEvent: vi.fn(),
      sendCronFailureAlert: vi.fn(async () => undefined),
    });

    await onTimer(state);

    // The recovery path must prove liveness from the process-local
    // reservation map, reclaim the orphaned marker, and make the job runnable
    // again on this or the next tick — instead of leaving it wedged.
    const reclaimed = () => state.store?.jobs.find((entry) => entry.id === job.id);
    await vi.waitFor(() => {
      expect(reclaimed()?.state.queuedAtMs).toBeUndefined();
    });
    await onTimer(state);
    expect(runCommandJob).toHaveBeenCalled();
  });
});
