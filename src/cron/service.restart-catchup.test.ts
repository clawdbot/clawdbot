import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent } from "./service/state.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
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

  function createOverdueEveryJob(id: string, nextRunAtMs: number) {
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

  async function withRestartedCron(
    jobs: unknown[],
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
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "digest now",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeat).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-overdue-job");
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
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
        expect(noopLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: "restart-stale-running" }),
          "cron: marking interrupted running job failed on startup",
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
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "finished",
            jobId: "restart-stale-running",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: staleRunningAt,
          }),
        );
      },
    );
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
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "catch missed slot",
          expect.objectContaining({ agentId: undefined }),
        );
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
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "finished",
            jobId: "restart-stale-one-shot",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: staleRunningAt,
          }),
        );
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
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "replay after backoff elapsed",
          expect.objectContaining({ agentId: undefined }),
        );
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
});
