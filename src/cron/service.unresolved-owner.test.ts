import { describe, expect, it, vi } from "vitest";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "./agent-id.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite();

describe("cron jobs with unresolved owners", () => {
  it.each(["startup", "timer", "reload"] as const)(
    "records the unowned job and keeps its owned sibling running during %s",
    async (phase) => {
      const { storePath, cleanup } = await makeStorePath();
      const now = Date.now();
      const dueAt = phase === "startup" ? now - 60_000 : now + 1_000;
      const unowned: CronJob = {
        id: "legacy-unowned",
        name: "legacy unowned command",
        enabled: true,
        createdAtMs: now - 120_000,
        updatedAtMs: now - 120_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: dueAt },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "command", argv: ["echo", "tick"] },
        state: { nextRunAtMs: dueAt },
      };
      const owned: CronJob = { ...structuredClone(unowned), id: "owned", agentId: "ops" };
      await saveCronStore(storePath, { version: 1, jobs: [unowned, owned] });
      const runCommandJob = vi.fn(async (_params: { job: CronJob }) => ({ status: "ok" as const }));
      const onEvent = vi.fn();
      let currentOwner: string | undefined = phase === "reload" ? "main" : undefined;
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: logger,
        ...(phase === "reload" ? { defaultAgentId: "main" } : {}),
        resolveDefaultAgentId: () => currentOwner,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
        runCommandJob,
        onEvent,
      });

      try {
        await cron.start();
        if (phase !== "startup") {
          currentOwner = undefined;
          if (phase === "reload") {
            expect(cron.getDefaultAgentId()).toBeUndefined();
            expect((await cron.listPage({ agentId: "main" })).jobs).toEqual([]);
          }
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await vi.waitFor(() => {
          expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({ jobId: owned.id, action: "finished", status: "ok" }),
          );
        });
        expect(runCommandJob).toHaveBeenCalledTimes(1);
        expect(runCommandJob).toHaveBeenCalledWith(
          expect.objectContaining({ job: expect.objectContaining({ id: owned.id }) }),
        );
        const persisted = (await loadCronStore(storePath)).jobs;
        expect(persisted.find((job) => job.id === unowned.id)?.state).toMatchObject({
          lastRunStatus: "skipped",
          lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
        });
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: unowned.id,
            action: "finished",
            status: "skipped",
            completionStatus: "failed",
            error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
          }),
        );

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(runCommandJob).toHaveBeenCalledTimes(2));
        expect(runCommandJob.mock.calls.every(([params]) => params.job.id === owned.id)).toBe(true);
      } finally {
        cron.stop();
        await cleanup();
      }
    },
  );
});
