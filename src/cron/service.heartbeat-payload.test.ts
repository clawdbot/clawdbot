// The system heartbeat monitor payload replaces the dedicated interval
// scheduler: firing it must only poke the heartbeat wake queue.
import { describe, expect, it } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("heartbeat payload execution", () => {
  it("fires as an interval heartbeat wake without enqueuing a system event", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const { cron, enqueueSystemEvent, requestHeartbeat } =
      createStartedCronServiceWithFinishedBarrier({ storePath, logger: noopLogger });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "heartbeat:main",
          name: "heartbeat-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;
      // System ownership boundary: no caller may create or patch to the
      // heartbeat payload without the gateway's opt-in.
      await expect(
        cron.add({
          name: "rogue",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(/system-owned/);
      await expect(cron.update(job.id, { payload: { kind: "heartbeat" } })).rejects.toThrow(
        /system-owned/,
      );
      // Existing monitors reject every patch, not just payload-kind edits.
      await expect(cron.update(job.id, { enabled: false })).rejects.toThrow(/system-owned/);
      // Ad-hoc deletion is rejected too; only reconciliation cleanup removes.
      await expect(cron.remove(job.id)).rejects.toThrow(/system-owned/);
      // A declarative upsert on the monitor's key cannot repurpose it either.
      await expect(
        cron.add({
          declarationKey: "heartbeat:main",
          name: "rogue-upsert",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "hijack" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(/system-owned/);
      const result = await cron.run(job.id, "force");
      expect(result.ok).toBe(true);
      expect(requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ source: "interval", intent: "scheduled", agentId: "main" }),
      );
      // The monitor never fabricates a system event; the wake is the whole run.
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cleanup();
    }
  });
});
