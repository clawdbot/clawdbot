import { describe, expect, it, vi } from "vitest";
import { CronService, type CronEvent } from "./service.js";
import { createFinishedBarrier, setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const { logger, makeStorePath } = setupCronServiceSuite();

describe("CronService persists delivery suppression", () => {
  it.each(["scheduled", "manual"] as const)(
    "persists %s delivery suppression in job state, history, and the finished event",
    async (mode) => {
      const { storePath } = await makeStorePath();
      const events: CronEvent[] = [];
      const finished = createFinishedBarrier();
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>();
      runIsolatedAgentJob.mockResolvedValue({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
        deliverySuppressionReason: "channel_transform",
      });
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.action === "finished") {
            events.push(event);
          }
          finished.onEvent(event);
        },
      });
      await cron.start();
      try {
        const job = await cron.add({
          name: "suppression-readback",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "test" },
          delivery: { mode: "announce", channel: "forum", to: "123" },
        });
        if (mode === "scheduled") {
          const done = finished.waitForOk(job.id);
          await vi.advanceTimersByTimeAsync(job.state.nextRunAtMs! - Date.now());
          await done;
        } else {
          await cron.run(job.id, "force");
        }
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect.soft(persisted?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDelivered: false,
          lastDeliveryStatus: "not-delivered",
          deliverySuppressionReason: "channel_transform",
        });
        expect.soft(persisted?.state.lastDeliveryError).toBeUndefined();
        expect
          .soft(events)
          .toEqual([expect.objectContaining({ deliverySuppressionReason: "channel_transform" })]);
        const history = readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(storePath),
          jobId: job.id,
        });
        expect
          .soft(history.entries)
          .toEqual([expect.objectContaining({ deliverySuppressionReason: "channel_transform" })]);

        runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
        vi.setSystemTime(Date.now() + 1);
        await cron.run(job.id, "force");
        expect(
          (await loadCronStore(storePath)).jobs[0]?.state.deliverySuppressionReason,
        ).toBeUndefined();
        expect(events.at(-1)?.deliverySuppressionReason).toBeUndefined();
        expect(
          readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries[0]?.deliverySuppressionReason,
        ).toBeUndefined();
      } finally {
        cron.stop();
      }
    },
  );
});
