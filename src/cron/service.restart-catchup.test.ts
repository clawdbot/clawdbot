// Restart catchup tests cover cron jobs missed while the service was stopped.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent } from "./service/state.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: CronJob[]) {
    await saveCronStore(storePath, { version: 1, jobs });
  }

  function createRestartCronService(params: {
    storePath: string;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
    onEvent?: ReturnType<typeof vi.fn>;
    nowMs?: () => number;
    runIsolatedAgentJob?: ReturnType<typeof vi.fn>;
    startupDeferredMissedAgentJobDelayMs?: number;
  }) {
    return new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLogger,
      ...(params.nowMs ? { nowMs: params.nowMs } : {}),
      enqueueSystemEvent: params.enqueueSystemEvent as never,
      requestHeartbeat: params.requestHeartbeat as never,
      runIsolatedAgentJob:
        (params.runIsolatedAgentJob as never) ??
        (vi.fn(async () => ({ status: "ok" as const })) as never),
      onEvent: params.onEvent as ((evt: CronEvent) => void) | undefined,
      ...(params.startupDeferredMissedAgentJobDelayMs !== undefined
        ? { startupDeferredMissedAgentJobDelayMs: params.startupDeferredMissedAgentJobDelayMs }
        : {}),
    });
  }

  function createOverdueEveryJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  function createOverdueIsolatedEveryJob(id: string, nextRunAtMs: number): CronJob {
    return {
      ...createOverdueEveryJob(id, nextRunAtMs),
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: `run-${id}` },
    };
  }

  function createOverdueCronJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  function createOverdueDisabledHeartbeatOneShotRetry(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `disabled-heartbeat-retry-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 30_000,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(nextRunAtMs - 30_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: `retry-${id}` },
      state: {
        nextRunAtMs,
        lastRunAtMs: nextRunAtMs - 30_000,
        lastRunStatus: "skipped",
        lastError: "disabled",
        consecutiveSkipped: 1,
      },
    };
  }

  function expectQueuedSystemEvent(
    enqueueSystemEvent: ReturnType<typeof vi.fn>,
    expectedText: string,
  ) {
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = enqueueSystemEvent.mock.calls[0] ?? [];
    expect(text).toBe(expectedText);
    expect((options as { agentId?: string } | undefined)?.agentId).toBeUndefined();
  }

  function expectInterruptedJobEvent(
    onEvent: ReturnType<typeof vi.fn>,
    expected: { jobId: string; runAtMs: number },
  ) {
    const event = onEvent.mock.calls
      .map(([evt]) => evt as CronEvent)
      .find((evt) => evt.action === "finished" && evt.jobId === expected.jobId);
    expect(event?.status).toBe("error");
    expect(event?.error).toBe("cron: job interrupted by gateway restart");
    expect(event?.runAtMs).toBe(expected.runAtMs);
  }

  async function withRestartedCron(
    jobs: CronJob[],
    run: (params: {
      cron: CronService;
      enqueueSystemEvent: ReturnType<typeof vi.fn>;
      requestHeartbeat: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
    }) => Promise<void>,
  ) {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const onEvent = vi.fn();

    await writeStoreJobs(store.storePath, jobs);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeat,
      onEvent,
    });

    try {
      await cron.start();
      await run({ cron, enqueueSystemEvent, requestHeartbeat, onEvent });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  }

  it("executes an overdue recurring job immediately on start", async () => {
    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-overdue-job",
          name: "daily digest",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-12T15:00:00.000Z"),
          schedule: { kind: "cron", expr: "0 15 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "digest now" },
          state: {
            nextRunAtMs: dueAt,
            lastRunAtMs: lastRunAt,
            lastStatus: "ok",
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expectQueuedSystemEvent(enqueueSystemEvent, "digest now");
        expect(requestHeartbeat).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-overdue-job");
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
      },
    );
  });

  it("preserves delivery target writeback from a startup catch-up run", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const job: CronJob = {
      ...createOverdueIsolatedEveryJob("restart-writeback", startNow - 60_000),
      delivery: { mode: "announce", channel: "telegram", to: originalTarget },
    };
    await writeStoreJobs(store.storePath, [job]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        const persisted = await loadCronStore(store.storePath);
        const targetJob = persisted.jobs.find((entry) => entry.id === params.job.id);
        if (targetJob?.delivery?.channel === "telegram") {
          targetJob.delivery.to = rewrittenTarget;
        }
        await saveCronStore(store.storePath, persisted);
        return { status: "ok" as const, summary: "done", delivered: true };
      }),
    });

    try {
      await runMissedJobs(state);

      const persisted = await loadCronStore(store.storePath);
      const updated = persisted.jobs.find((entry) => entry.id === job.id);
      expect(updated?.delivery?.to).toBe(rewrittenTarget);
      expect(updated?.state.lastRunStatus).toBe("ok");
      expect(updated?.state.lastDelivered).toBe(true);
    } finally {
      await store.cleanup();
    }
  });

  it("persists successful script state from a startup catch-up run", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const job: CronJob = {
      ...createOverdueEveryJob("restart-script-state", startNow - 60_000),
      payload: { kind: "script", script: "return { state: { revision: 2 } }" },
      state: {
        nextRunAtMs: startNow - 60_000,
        triggerState: { revision: 1 },
      },
    };
    await writeStoreJobs(store.storePath, [job]);

    const state = createCronServiceState({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
      })),
    });

    try {
      await runMissedJobs(state);

      const persisted = await loadCronStore(store.storePath);
      expect(persisted.jobs[0]?.state.triggerState).toEqual({ revision: 2 });
    } finally {
      await store.cleanup();
    }
  });

  it("does not resurrect a job removed during startup catch-up", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const job = createOverdueIsolatedEveryJob("restart-self-removal", startNow - 60_000);
    await writeStoreJobs(store.storePath, [job]);

    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent: (event) => {
        events.push(event);
      },
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        const persisted = await loadCronStore(store.storePath);
        await saveCronStore(store.storePath, {
          ...persisted,
          jobs: persisted.jobs.filter((entry) => entry.id !== params.job.id),
        });
        return { status: "ok" as const, summary: "removed", delivered: false };
      }),
    });

    try {
      await runMissedJobs(state);

      expect((await loadCronStore(store.storePath)).jobs).toStrictEqual([]);
      expect(state.store?.jobs).toStrictEqual([]);
      expect(
        events.some(
          (event) => event.jobId === job.id && event.action === "finished" && event.status === "ok",
        ),
      ).toBe(true);
    } finally {
      await store.cleanup();
    }
  });

  it("does not replay completed one-shot jobs restored with lastRunStatus only", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-one-shot-last-run-status",
          name: "finished one shot",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: dueAt,
          schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not replay one shot" },
          state: {
            nextRunAtMs: dueAt,
            lastRunAtMs: dueAt,
            lastRunStatus: "ok",
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-one-shot-last-run-status");
        expect(updated?.state.nextRunAtMs).toBeUndefined();
        expect(updated?.state.lastRunStatus).toBe("ok");
        expect(updated?.state.lastStatus).toBeUndefined();
      },
    );
  });

  it("defers overdue isolated agent-turn jobs during gateway startup", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();

    await writeStoreJobs(store.storePath, [
      {
        id: "startup-isolated-agent",
        name: "startup isolated agent",
        enabled: true,
        createdAtMs: startNow - 120_000,
        updatedAtMs: startNow - 120_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: startNow - 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "do work" },
        state: { nextRunAtMs: startNow - 60_000 },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
      nowMs: () => startNow,
      startupDeferredMissedAgentJobDelayMs: 120_000,
    });

    try {
      await cron.start();

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();

      const listedJobs = await cron.list({ includeDisabled: true });
      const updated = listedJobs.find((job) => job.id === "startup-isolated-agent");
      expect(updated?.state.lastStatus).toBeUndefined();
      expect(updated?.state.runningAtMs).toBeUndefined();
      expect(updated?.state.nextRunAtMs).toBe(startNow + 120_000);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it.each(["ok", "skipped"] as const)(
    "does not defer an isolated cron agent-turn whose persisted due slot finished as %s",
    async (lastRunStatus) => {
      const store = await makeStorePath();
      const startNow = Date.parse("2025-12-13T11:00:00.000Z");
      const dueAt = Date.parse("2025-12-13T09:10:00.000Z");
      const completedAt = Date.parse("2025-12-13T09:10:30.000Z");
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();

      await writeStoreJobs(store.storePath, [
        {
          id: `startup-isolated-agent-already-${lastRunStatus}`,
          name: `startup isolated agent already ${lastRunStatus}`,
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: completedAt,
          schedule: { kind: "cron", expr: "10 9 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "daily reminder" },
          state: {
            nextRunAtMs: dueAt,
            lastRunAtMs: completedAt,
            lastRunStatus,
          },
        },
      ]);

      const cron = createRestartCronService({
        storePath: store.storePath,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob,
        nowMs: () => startNow,
        startupDeferredMissedAgentJobDelayMs: 120_000,
      });

      try {
        await cron.start();

        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find(
          (job) => job.id === `startup-isolated-agent-already-${lastRunStatus}`,
        );
        expect(updated?.state.lastRunStatus).toBe(lastRunStatus);
        expect(updated?.state.nextRunAtMs).toBe(Date.parse("2025-12-14T09:10:00.000Z"));
      } finally {
        cron.stop();
        await store.cleanup();
      }
    },
  );

  it("replays a newer missed cron slot behind a completed persisted slot", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:10:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-completed-slot-newer-miss",
          name: "completed slot with newer miss",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "newer slot missed" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastRunStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeat }) => {
        expectQueuedSystemEvent(enqueueSystemEvent, "newer slot missed");
        expect(requestHeartbeat).toHaveBeenCalled();
      },
    );
  });

  it("replays a cron slot due exactly at restart behind a completed persisted slot", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-completed-slot-boundary-miss",
          name: "completed slot with boundary miss",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "boundary slot missed" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastRunStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeat }) => {
        expectQueuedSystemEvent(enqueueSystemEvent, "boundary slot missed");
        expect(requestHeartbeat).toHaveBeenCalled();
      },
    );
  });

  it("marks interrupted recurring jobs failed instead of replaying them on startup", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-stale-running",
          name: "daily stale marker",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "resume stale marker" },
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat, onEvent }) => {
        const warning = vi
          .mocked(noopLogger.warn)
          .mock.calls.find(
            ([, message]) => message === "cron: marking interrupted running job failed on startup",
          );
        expect((warning?.[0] as { jobId?: string } | undefined)?.jobId).toBe(
          "restart-stale-running",
        );

        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-running");
        expect(updated?.state.runningAtMs).toBeUndefined();
        expect(updated?.state.lastStatus).toBe("error");
        expect(updated?.state.lastRunStatus).toBe("error");
        expect(updated?.state.lastRunAtMs).toBe(staleRunningAt);
        expect(updated?.state.lastError).toBe("cron: job interrupted by gateway restart");
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
        expectInterruptedJobEvent(onEvent, {
          jobId: "restart-stale-running",
          runAtMs: staleRunningAt,
        });
      },
    );
  });

  it("releases queued reservations and runs due jobs after restart", async () => {
    const dueAt = Date.parse("2025-12-13T16:30:00.000Z");
    const queuedAt = Date.parse("2025-12-13T16:45:00.000Z");
    const recurring = createOverdueEveryJob("restart-queued-recurring", dueAt);
    recurring.state.queuedAtMs = queuedAt;
    const oneShot: CronJob = {
      id: "restart-queued-one-shot",
      name: "queued one shot",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: dueAt - 60_000,
      updatedAtMs: queuedAt,
      schedule: { kind: "at", at: new Date(dueAt).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "queued-one-shot" },
      state: { nextRunAtMs: dueAt, queuedAtMs: queuedAt },
    };

    await withRestartedCron([recurring, oneShot], async ({ cron, enqueueSystemEvent, onEvent }) => {
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
      expect(enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual(
        expect.arrayContaining(["tick-restart-queued-recurring", "queued-one-shot"]),
      );

      const listedJobs = await cron.list({ includeDisabled: true });
      const updatedRecurring = listedJobs.find((job) => job.id === recurring.id);
      expect(updatedRecurring?.state.queuedAtMs).toBeUndefined();
      expect(updatedRecurring?.state.lastRunStatus).toBe("ok");
      expect(updatedRecurring?.enabled).toBe(true);
      expect(listedJobs.some((job) => job.id === oneShot.id)).toBe(false);
      expect(
        onEvent.mock.calls.some(
          ([evt]) =>
            (evt as CronEvent).action === "finished" &&
            (evt as CronEvent).error === "cron: job interrupted by gateway restart",
        ),
      ).toBe(false);
    });
  });

  it("replays the most recent missed cron slot after restart when nextRunAtMs already advanced", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-missed-slot",
          name: "every ten minutes +1",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "catch missed slot" },
          state: {
            // Persisted state may already be recomputed from restart time and
            // point to the future slot, even though 04:01 was missed.
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expectQueuedSystemEvent(enqueueSystemEvent, "catch missed slot");
        expect(requestHeartbeat).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-missed-slot");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));
      },
    );
  });

  it("marks interrupted one-shot jobs failed and disabled on startup", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-stale-one-shot",
          name: "one shot stale marker",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "one-shot stale marker" },
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat, onEvent }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-one-shot");
        expect(updated?.enabled).toBe(false);
        expect(updated?.state.runningAtMs).toBeUndefined();
        expect(updated?.state.lastStatus).toBe("error");
        expect(updated?.state.lastRunStatus).toBe("error");
        expect(updated?.state.lastRunAtMs).toBe(staleRunningAt);
        expect(updated?.state.nextRunAtMs).toBeUndefined();
        expect(updated?.state.lastError).toBe("cron: job interrupted by gateway restart");
        expectInterruptedJobEvent(onEvent, {
          jobId: "restart-stale-one-shot",
          runAtMs: staleRunningAt,
        });
      },
    );
  });

  it("does not replay cron slot when the latest slot already ran before restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-no-duplicate-slot",
          name: "every ten minutes +1 no duplicate",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "already ran" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
      },
    );
  });

  it("does not replay missed cron slots while error backoff is pending after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-backoff-pending",
          name: "backoff pending",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not run during backoff" },
          state: {
            // Next retry is intentionally delayed by backoff despite a newer cron slot.
            nextRunAtMs: Date.parse("2025-12-13T04:10:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "error",
            consecutiveErrors: 4,
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
      },
    );
  });

  it("keeps missed cron slots paused until run-end error backoff expires after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:01:59.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-long-run-backoff-pending",
          name: "long run backoff pending",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not replay long failed run" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:10:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:00:00.000Z"),
            lastDurationMs: 90_000,
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-long-run-backoff-pending");
        expect(updated?.state.nextRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));
      },
    );
  });

  it("keeps past-due retries paused until run-end error backoff expires after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:01:59.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-long-run-due-retry",
          name: "long run due retry",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:00:30.000Z"),
          schedule: {
            kind: "every",
            everyMs: 60_000,
            anchorMs: Date.parse("2025-12-13T04:00:00.000Z"),
          },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not run early retry" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:00:30.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:00:00.000Z"),
            lastDurationMs: 90_000,
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-long-run-due-retry");
        expect(updated?.state.nextRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));
      },
    );
  });

  it("keeps past-due retries paused when restored with lastRunStatus only", async () => {
    vi.setSystemTime(new Date("2025-12-13T17:00:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-backoff-last-run-status",
          name: "lastRunStatus backoff pending",
          enabled: true,
          createdAtMs: Date.parse("2025-12-13T16:50:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T16:59:45.000Z"),
          schedule: {
            kind: "every",
            everyMs: 60_000,
            anchorMs: Date.parse("2025-12-13T16:50:00.000Z"),
          },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not run during lastRunStatus backoff" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T16:59:50.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T16:59:45.000Z"),
            lastDurationMs: 0,
            lastRunStatus: "error",
            consecutiveErrors: 1,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-backoff-last-run-status");
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
        expect(updated?.state.lastRunStatus).toBe("error");
        expect(updated?.state.lastStatus).toBeUndefined();
      },
    );
  });

  it("replays missed cron slot after restart when error backoff has already elapsed", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-backoff-elapsed-replay",
          name: "backoff elapsed replay",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "replay after backoff elapsed" },
          state: {
            // Startup maintenance may already point to a future slot (04:11) even
            // though 04:01 was missed and the 30s error backoff has elapsed.
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeat }) => {
        expectQueuedSystemEvent(enqueueSystemEvent, "replay after backoff elapsed");
        expect(requestHeartbeat).toHaveBeenCalled();
      },
    );
  });

  it("reschedules deferred missed jobs from the post-catchup clock so they stay in the future", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;

    await writeStoreJobs(store.storePath, [
      createOverdueEveryJob("stagger-0", startNow - 60_000),
      createOverdueEveryJob("stagger-1", startNow - 50_000),
      createOverdueEveryJob("stagger-2", startNow - 40_000),
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 6_000;
        return { status: "ok" as const, summary: "ok" };
      }),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });

    await runMissedJobs(state);

    const staggeredJobs = (state.store?.jobs ?? [])
      .filter((job) => job.id.startsWith("stagger-") && job.id !== "stagger-0")
      .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

    expect(staggeredJobs).toHaveLength(2);
    expect(staggeredJobs[0]?.state.nextRunAtMs).toBeGreaterThan(now);
    expect(staggeredJobs[1]?.state.nextRunAtMs).toBeGreaterThan(
      staggeredJobs[0]?.state.nextRunAtMs ?? 0,
    );
    expect(
      (staggeredJobs[1]?.state.nextRunAtMs ?? 0) - (staggeredJobs[0]?.state.nextRunAtMs ?? 0),
    ).toBe(5_000);

    await store.cleanup();
  });

  it("keeps startup overflow cron deferrals before the next natural cron slot", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;

    await writeStoreJobs(store.storePath, [
      createOverdueCronJob("cron-stagger-0", Date.parse("2025-12-13T16:00:00.000Z")),
      createOverdueCronJob("cron-stagger-1", Date.parse("2025-12-13T16:05:00.000Z")),
      createOverdueCronJob("cron-stagger-2", Date.parse("2025-12-13T16:10:00.000Z")),
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 6_000;
        return { status: "ok" as const, summary: "ok" };
      }),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });

    await runMissedJobs(state);

    const deferredJobs = (state.store?.jobs ?? [])
      .filter((job) => job.id.startsWith("cron-stagger-") && job.id !== "cron-stagger-0")
      .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

    expect(deferredJobs).toHaveLength(2);
    expect(deferredJobs[0]?.state.nextRunAtMs).toBe(startNow + 5_000);
    expect(deferredJobs[1]?.state.nextRunAtMs).toBe(startNow + 10_000);

    await store.cleanup();
  });

  it("stagger-limits overdue disabled-heartbeat one-shot retries after restart", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");

    await writeStoreJobs(store.storePath, [
      createOverdueDisabledHeartbeatOneShotRetry("disabled-retry-0", startNow - 60_000),
      createOverdueDisabledHeartbeatOneShotRetry("disabled-retry-1", startNow - 45_000),
    ]);

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });

    await runMissedJobs(state);

    expectQueuedSystemEvent(enqueueSystemEvent, "retry-disabled-retry-0");
    expect(requestHeartbeat).toHaveBeenCalledTimes(1);

    const listedJobs = state.store?.jobs ?? [];
    expect(listedJobs.find((job) => job.id === "disabled-retry-0")).toBeUndefined();
    const deferred = listedJobs.find((job) => job.id === "disabled-retry-1");
    expect(deferred?.enabled).toBe(true);
    expect(deferred?.state.lastRunStatus).toBe("skipped");
    expect(deferred?.state.lastError).toBe("disabled");
    expect(deferred?.state.nextRunAtMs).toBe(startNow + 5_000);

    await store.cleanup();
  });
});
