// The system heartbeat monitor payload replaces the dedicated interval
// scheduler: firing it must only poke the heartbeat wake queue.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { listCronHeartbeatWaitOwners } from "./active-jobs.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import type { CronEvent } from "./service.js";
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
    const { cron, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait } =
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
      expect(requestHeartbeatAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "interval",
          intent: "scheduled",
          agentId: "main",
          scheduledEveryMs: 60_000,
        }),
        expect.objectContaining({
          abortSignal: expect.any(AbortSignal),
        }),
      );
      expect(requestHeartbeat).not.toHaveBeenCalled();
      // The monitor never fabricates a system event; its settled wake is the whole run.
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it.each([
    {
      label: "failure",
      child: { status: "failed", reason: "agent-runner-failure" } as HeartbeatRunResult,
      expectedStatus: "error",
      expectedCompletion: "failed",
      expectedError: "heartbeat failed: agent-runner-failure",
      expectedConsecutiveErrors: 1,
    },
    {
      label: "success",
      child: { status: "ran", durationMs: 75 } as HeartbeatRunResult,
      expectedStatus: "ok",
      expectedCompletion: "succeeded",
      expectedError: undefined,
      expectedConsecutiveErrors: 0,
    },
    {
      label: "disabled skip",
      child: { status: "skipped", reason: "disabled" } as HeartbeatRunResult,
      expectedStatus: "skipped",
      expectedCompletion: "failed",
      expectedError: "heartbeat skipped: disabled",
      expectedConsecutiveErrors: 0,
    },
  ])("records the settled heartbeat child $label", async (testCase) => {
    const { storePath, cleanup } = await makeStorePath();
    const child = createDeferred<HeartbeatRunResult>();
    const events: CronEvent[] = [];
    const { cron, requestHeartbeatAndWait } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      requestHeartbeatAndWait: async () => await child.promise,
      onEvent: (event) => events.push(structuredClone(event)),
    });
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

      const runPromise = cron.run(job.id, "force");
      await vi.waitFor(() => expect(requestHeartbeatAndWait).toHaveBeenCalledOnce());
      expect(events.some((event) => event.action === "finished")).toBe(false);
      expect(cron.getJob(job.id)?.state.runningAtMs).toEqual(expect.any(Number));

      child.resolve(testCase.child);
      await expect(runPromise).resolves.toMatchObject({ ok: true, ran: true });

      const finished = events.findLast(
        (event) => event.action === "finished" && event.jobId === job.id,
      );
      expect(finished).toMatchObject({
        status: testCase.expectedStatus,
        completionStatus: testCase.expectedCompletion,
        ...(testCase.expectedError === undefined ? {} : { error: testCase.expectedError }),
      });
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: testCase.expectedStatus,
        lastStatus: testCase.expectedStatus,
        consecutiveErrors: testCase.expectedConsecutiveErrors,
      });
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("settles an enqueued manual heartbeat run without its Cron lane self-blocking", async () => {
    const { storePath, cleanup } = await makeStorePath();
    let observedWaitOwners: ReturnType<typeof listCronHeartbeatWaitOwners> | undefined;
    const { cron, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      requestHeartbeatAndWait: async () => {
        observedWaitOwners = listCronHeartbeatWaitOwners();
        return { status: "ran", durationMs: 1 };
      },
    });
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
      const terminal = finished.waitForOk(job.id);

      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
      await expect(terminal).resolves.toMatchObject({
        status: "ok",
        completionStatus: "succeeded",
      });
      expect(observedWaitOwners?.activeJobMarkers).toEqual([
        expect.objectContaining({ jobId: job.id }),
      ]);
      expect(observedWaitOwners?.owningCronLaneTaskMarkers).toEqual([
        expect.objectContaining({ lane: "cron" }),
      ]);
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("times out an unsettled heartbeat wake without authoring success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const { storePath, cleanup } = await makeStorePath();
    const events: CronEvent[] = [];
    const { cron, requestHeartbeatAndWait } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      requestHeartbeatAndWait: async (_request, lifecycle) =>
        await new Promise<HeartbeatRunResult>((resolve) => {
          const onAbort = () => resolve({ status: "failed", reason: "heartbeat wake cancelled" });
          if (lifecycle.abortSignal?.aborted) {
            onAbort();
          } else {
            lifecycle.abortSignal?.addEventListener("abort", onAbort, { once: true });
          }
        }),
      onEvent: (event) => events.push(structuredClone(event)),
    });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "heartbeat:main",
          name: "heartbeat-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60 * 60_000 },
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;
      const runPromise = cron.run(job.id, "force");
      await vi.waitFor(() => expect(requestHeartbeatAndWait).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(runPromise).resolves.toMatchObject({ ok: true, ran: true });

      expect(events.findLast((event) => event.action === "finished")).toMatchObject({
        status: "error",
        completionStatus: "failed",
        error: expect.stringContaining("job execution timed out"),
      });
    } finally {
      cron.stop();
      await cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps ordinary system-event cron completion dispatch-only", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const events: CronEvent[] = [];
    const { cron, requestHeartbeat, requestHeartbeatAndWait } =
      createStartedCronServiceWithFinishedBarrier({
        storePath,
        logger: noopLogger,
        onEvent: (event) => events.push(structuredClone(event)),
      });
    try {
      await cron.start();
      const job = await cron.add({
        name: "ordinary system event",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "dispatch this event" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });

      await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true, ran: true });

      expect(requestHeartbeat).toHaveBeenCalledOnce();
      expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
      expect(events.findLast((event) => event.action === "finished")).toMatchObject({
        status: "ok",
        completionStatus: "succeeded",
        summary: "dispatch this event",
      });
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
    const { cron, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait } =
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
      expect(requestHeartbeatAndWait).toHaveBeenCalledWith(
        {
          source: "interval",
          intent: "task",
          reason: `heartbeat-task:${job.id}`,
          agentId: "main",
          tasks: [{ jobId: job.id, name: "inbox", prompt: "Check urgent inbox items" }],
        },
        expect.objectContaining({
          abortSignal: expect.any(AbortSignal),
        }),
      );
      expect(requestHeartbeat).not.toHaveBeenCalled();
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
