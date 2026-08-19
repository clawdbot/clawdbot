import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-run-receipt-settlement-",
});

function makeTimedJob(id: string, nextRunAtMs: number): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: nextRunAtMs - 1,
    updatedAtMs: nextRunAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"], timeoutSeconds: 1 },
    state: { nextRunAtMs },
  };
}

function makeService(
  storePath: string,
  runCommandJob: NonNullable<ConstructorParameters<typeof CronService>[0]["runCommandJob"]>,
) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
  });
}

function latestReceiptStatus(storePath: string, jobId: string): string | undefined {
  const row = openOpenClawStateDatabase()
    .db.prepare(
      "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get(cronStoreKey(storePath), jobId) as { status: string } | undefined;
  return row?.status;
}

describe("cron run receipt settlement", () => {
  it.each(["manual", "startup"] as const)(
    "keeps a timed-out %s runner fenced until its underlying work settles",
    async (trigger) => {
      vi.useRealTimers();
      const { storePath } = await makeStorePath();
      const now = Date.now();
      const job = makeTimedJob(
        `late-${trigger}-settlement`,
        trigger === "manual" ? now + 60_000 : now - 1,
      );
      await saveCronStore(storePath, { version: 1, jobs: [job] });

      const runnerStarted = createDeferred();
      const releaseRunner = createDeferred<{ status: "ok"; summary: string }>();
      const owner = makeService(storePath, async () => {
        runnerStarted.resolve();
        return await releaseRunner.promise;
      });
      const successorRunner = vi.fn(async () => ({ status: "ok" as const }));
      const successor = makeService(storePath, successorRunner);
      const first =
        trigger === "manual" ? owner.run(job.id, "force").then(() => undefined) : owner.start();

      try {
        await runnerStarted.promise;
        await first;
        expect(latestReceiptStatus(storePath, job.id)).toBe("running");
        await expect(successor.run(job.id, "force")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "already-running",
        });
        expect(successorRunner).not.toHaveBeenCalled();

        releaseRunner.resolve({ status: "ok", summary: "late runner settled" });
        await vi.waitFor(() => expect(latestReceiptStatus(storePath, job.id)).toBe("error"));
        owner.stop();

        await expect(successor.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(successorRunner).toHaveBeenCalledOnce();
      } finally {
        releaseRunner.resolve({ status: "ok", summary: "late runner settled" });
        await first.catch(() => undefined);
        owner.stop();
        successor.stop();
      }
    },
  );
});
