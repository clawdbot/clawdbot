import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as detachedTaskRuntime from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { run, start, stop, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

function withStateDirForStorePath(storePath: string) {
  const stateRoot = path.dirname(path.dirname(storePath));
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  resetTaskRegistryForTests();
  return () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  };
}

function createTimedOutIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => {
      throw new Error("cron: job execution timed out");
    }),
  });
}

function createOkIsolatedCronState(params: { storePath: string; now: number; summary?: string }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      ...(params.summary === undefined ? {} : { summary: params.summary }),
    })),
  });
}

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
    },
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    id: "isolated-timeout",
    name: "isolated timeout",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

async function writeDueIsolatedJobSnapshot(storePath: string, now: number) {
  await writeCronStoreSnapshot({
    storePath,
    jobs: [createDueIsolatedJob(now)],
  });
}

async function expectDueIsolatedManualRunProgresses(storePath: string, now: number) {
  const state = createOkIsolatedCronState({ storePath, now, summary: "done" });

  await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

  const persisted = (await loadCronStore(storePath)) as {
    jobs: CronJob[];
  };
  expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    id: "startup-timeout",
    name: "startup timeout",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "should timeout" },
    sessionKey: "agent:main:main",
    state: {
      nextRunAtMs: now - 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("start clears stale running markers, replays interrupted recurring jobs, persists, and arms the timer (#60495)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedMainJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-interrupted" }),
      "cron: clearing stale running marker on startup",
    );
    // Interrupted recurring jobs are now replayed on first restart (#60495)
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalled();
    expect(state.timer).not.toBeNull();

    const persisted = (await loadCronStore(storePath)) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect((job?.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDirForStorePath(storePath);

    await writeDueIsolatedJobSnapshot(storePath, now);

    const state = createTimedOutIsolatedCronState({
      storePath,
      now,
    });

    await run(state, "isolated-timeout");

    expect(findTaskByRunId(`cron:isolated-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      status: "timed_out",
      sourceId: "isolated-timeout",
    });

    restoreStateDir();
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const createTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    await expectDueIsolatedManualRunProgresses(storePath, now);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "isolated-timeout" }),
      "cron: failed to create task ledger record",
    );

    createTaskRecordSpy.mockRestore();
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeDueIsolatedJobSnapshot(storePath, now);

    const updateTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "completeTaskRunByRunId")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    await expectDueIsolatedManualRunProgresses(storePath, now);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobStatus: "ok" }),
      "cron: failed to update task ledger record",
    );

    updateTaskRecordSpy.mockRestore();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  });

  it("non-schedule edit preserves nextRunAtMs (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const originalNextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "daily-report",
          name: "daily report",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs: originalNextRunAtMs },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "daily-report", { description: "edited" });

    expect(updated.description).toBe("edited");
    expect(updated.state.nextRunAtMs).toBe(originalNextRunAtMs);
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "broken-job",
          name: "broken",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: 0 },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDirForStorePath(storePath);

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMissedIsolatedJob(now)],
    });

    const state = createTimedOutIsolatedCronState({
      storePath,
      now,
    });

    await start(state);

    expect(findTaskByRunId(`cron:startup-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      status: "timed_out",
      sourceId: "startup-timeout",
    });

    restoreStateDir();
    stop(state);
  });
});
