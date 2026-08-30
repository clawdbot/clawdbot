// The system heartbeat monitor payload replaces the dedicated interval
// scheduler: firing it must only poke the heartbeat wake queue.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
import { loadCronJobsStore } from "./store.js";
import type { CronJobCreate } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("heartbeat payload execution", () => {
  it.each(["returned", "threw", "stopped", "restarted"] as const)(
    "rejects in-flight and retained monitor writes after its owner %s",
    async (expiry) => {
      const { storePath, cleanup } = await makeStorePath();
      const inventoryStarted = createDeferred();
      const releaseInventory = createDeferred();
      const releaseOwner = createDeferred();
      const pending = createDeferred<{
        add: CronService["add"];
        mutation: ReturnType<CronService["add"]>;
      }>();
      let blockInventory = false;
      const { cron, withSystemMonitorReconciliation } = CronService.createWithMonitorReconciliation(
        {
          storePath,
          cronEnabled: false,
          log: noopLogger,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          isAgentAvailable: (agentId) => agentId === "main",
          listConfiguredChannels: async () => {
            if (blockInventory) {
              inventoryStarted.resolve();
              await releaseInventory.promise;
            }
            return [];
          },
        },
      );
      const owner = {
        assertCurrent: () => {},
        assertAgentAvailable: (agentId: string) => {
          if (agentId !== "work") {
            throw new Error(`candidate agent is unavailable: ${agentId}`);
          }
        },
      };
      const monitor = {
        declarationKey: "heartbeat:work",
        name: "heartbeat-work",
        agentId: "work",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "heartbeat" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      } satisfies CronJobCreate;
      const options = { systemOwned: true, enabledExplicit: true };
      const ownerFailure = new Error("monitor pass failed");
      let settledOwner: Promise<unknown> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        await withSystemMonitorReconciliation(owner, async (add) => await add(monitor, options));
        const persistedBefore = (await loadCronJobsStore(storePath)).jobs;
        expect(persistedBefore).toHaveLength(1);
        await expect(cron.add(monitor, options)).rejects.toThrow(
          "cron job agent is unavailable: work",
        );

        blockInventory = true;
        const updatedMonitor = {
          ...monitor,
          schedule: { kind: "every" as const, everyMs: 120_000 },
        };
        const reconciliation = withSystemMonitorReconciliation(owner, async (add) => {
          const inFlight = add(updatedMonitor, options);
          void inFlight.catch(() => undefined);
          pending.resolve({ add, mutation: inFlight });
          await releaseOwner.promise;
          if (expiry === "threw") {
            throw ownerFailure;
          }
        });
        settledOwner = reconciliation.catch((error: unknown) => error);
        const captured = await pending.promise;
        mutation = captured.mutation;
        await inventoryStarted.promise;

        if (expiry === "returned" || expiry === "threw") {
          releaseOwner.resolve();
          await expect(settledOwner).resolves.toBe(expiry === "threw" ? ownerFailure : undefined);
        } else {
          cron.stop();
          if (expiry === "restarted") {
            // Scheduling is disabled, so restart resets stopped without waiting
            // on this add; only the lifecycle generation can reject the old owner.
            await cron.start();
          }
        }
        releaseInventory.resolve();
        await expect(mutation).rejects.toThrow("cron monitor reconciliation is no longer active");
        await expect(captured.add(updatedMonitor, options)).rejects.toThrow(
          "cron monitor reconciliation is no longer active",
        );
        expect((await loadCronJobsStore(storePath)).jobs).toEqual(persistedBefore);
      } finally {
        releaseInventory.resolve();
        releaseOwner.resolve();
        await mutation?.catch(() => undefined);
        await settledOwner;
        cron.stop();
        await cleanup();
      }
    },
  );

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
        expect.objectContaining({
          source: "interval",
          intent: "scheduled",
          agentId: "main",
          scheduledEveryMs: 60_000,
        }),
      );
      // The monitor never fabricates a system event; the wake is the whole run.
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("executes skill collection review payloads through the injected runner", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const runSkillCollectionReview = vi.fn(async ({ agentId }: { agentId: string }) => ({
      status: "ok" as const,
      summary: `reviewed ${agentId}`,
    }));
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "skill-collection-review:main",
          name: "skill-collection-review-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;

      await expect(
        cron.add({
          declarationKey: "skill-collection-review:main",
          name: "rogue-collision",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "hijack" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(
        'cron declarationKey namespace "skill-collection-review:" is system-owned; jobs cannot be created with it',
      );
      await expect(
        cron.add(
          {
            declarationKey: "skill-collection-review:main",
            name: "skill-collection-review-main",
            agentId: "main",
            enabled: true,
            schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
            payload: { kind: "skillCollectionReview" },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
          },
          { enabledExplicit: true, systemOwned: true },
        ),
      ).resolves.toMatchObject({ job: { id: job.id } });

      await expect(
        cron.add({
          name: "rogue",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(/system-owned/);
      await expect(
        cron.update(job.id, { payload: { kind: "skillCollectionReview" } }),
      ).rejects.toThrow(/system-owned/);
      await expect(cron.update(job.id, { enabled: false })).rejects.toThrow(/system-owned/);
      await expect(cron.remove(job.id)).rejects.toThrow(/system-owned/);

      await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
      expect(runSkillCollectionReview).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", abortSignal: expect.any(AbortSignal) }),
      );
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("revokes an active skill review before a disabled monitor can write", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const settled = createDeferred();
    const finalWrite = vi.fn();
    const runSkillCollectionReview = vi.fn(
      async ({ abortSignal }: { agentId: string; abortSignal?: AbortSignal }) => {
        if (!abortSignal) {
          throw new Error("skill review cancellation signal missing");
        }
        started.resolve(abortSignal);
        try {
          await release.promise;
          abortSignal.throwIfAborted();
          finalWrite();
          return { status: "ok" as const, summary: "reviewed main" };
        } finally {
          settled.resolve();
        }
      },
    );
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    const monitor = {
      declarationKey: "skill-collection-review:main",
      name: "skill-collection-review-main",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 7 * 24 * 60 * 60_000 },
      payload: { kind: "skillCollectionReview" as const },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
    };
    let activeRun: Promise<unknown> | undefined;
    try {
      await cron.start();
      const added = await cron.add(monitor, { enabledExplicit: true, systemOwned: true });
      const job = "job" in added ? added.job : added;
      activeRun = cron.run(job.id, "force");
      const abortSignal = await started.promise;

      await cron.add({ ...monitor, enabled: false }, { enabledExplicit: true, systemOwned: true });

      expect(abortSignal.aborted).toBe(true);
      release.resolve();
      await settled.promise;
      await activeRun;
      expect(finalWrite).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.enabled).toBe(false);
    } finally {
      release.resolve();
      await activeRun?.catch(() => undefined);
      cron.stop();
      await cleanup();
    }
  });

  it("keeps failing skill collection reviews enabled", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const runSkillCollectionReview = vi.fn(async () => ({
      status: "error" as const,
      summary: "review failed",
      error: "review failed",
    }));
    const { cron, enqueueSystemEvent } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "skill-collection-review:main",
          name: "skill-collection-review-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;

      for (let attempt = 0; attempt < 11; attempt++) {
        vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
        await expect(cron.run(job.id, "due")).resolves.toMatchObject({ ok: true });
      }

      expect(runSkillCollectionReview).toHaveBeenCalledTimes(11);
      const failedJob = cron.getJob(job.id);
      expect(failedJob).toMatchObject({
        enabled: true,
        state: { lastStatus: "error", lastError: "review failed" },
      });
      expect(failedJob?.state.consecutiveErrors).toBe(11);
      expect(failedJob?.state.autoDisabled).toBeUndefined();
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("auto-disabled"),
        expect.anything(),
      );
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("routes migrated task jobs through the guarded task wake path", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const { cron, enqueueSystemEvent, requestHeartbeat } =
      createStartedCronServiceWithFinishedBarrier({ storePath, logger: noopLogger });
    try {
      await cron.start();
      const declarationKey = heartbeatTaskDeclarationKey("main", "inbox");
      await expect(
        cron.add({
          declarationKey,
          name: "ordinary automation",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "This must use normal cron delivery" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(/system-owned/);

      const added = await cron.add(
        {
          declarationKey,
          name: "inbox",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "Check urgent inbox items" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { systemOwned: true },
      );
      const job = "job" in added ? added.job : added;

      await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${job.id}`,
        agentId: "main",
        tasks: [{ jobId: job.id, name: "inbox", prompt: "Check urgent inbox items" }],
      });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();

      // These stay ordinary cron rows: operators can edit and remove them.
      await expect(
        cron.update(job.id, { payload: { kind: "systemEvent", text: "Check priority inbox" } }),
      ).resolves.toMatchObject({ id: job.id });
      await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });
    } finally {
      cron.stop();
      await cleanup();
    }
  });
});
