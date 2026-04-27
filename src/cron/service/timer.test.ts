import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import * as detachedTaskRuntime from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: params.now - 1 },
  };
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
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

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: "agent:main:main",
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "cron:main-heartbeat-job",
      agentId: undefined,
      sessionKey: "agent:main:main",
      heartbeat: { target: "last" },
    });

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.nextRunAtMs).toBe(now + 60_000);
    expect(findTaskByRunId(`cron:main-heartbeat-job:${now}`)).toMatchObject({
      runtime: "cron",
      status: "succeeded",
      endedAt: now,
      cleanupAfter: expect.any(Number),
    });

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
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

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "main-heartbeat-job" }),
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: "agent:main:main",
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });

  it("reloads externally edited split-store schedules without firing stale slots", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T06:00:00.000Z");
    const staleNextRunAtMs = now;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "externally-edited-cron",
          name: "externally edited cron",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "stale schedule should not run" },
          state: { nextRunAtMs: staleNextRunAtMs },
        },
      ],
    });

    const config = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    config.jobs[0].schedule = { kind: "cron", expr: "0 7 * * *", tz: "UTC" };
    await fs.writeFile(storePath, JSON.stringify(config, null, 2), "utf8");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    expect(job?.schedule).toEqual({ kind: "cron", expr: "0 7 * * *", tz: "UTC" });
    expect(job?.state.lastStatus).toBeUndefined();
    expect(job?.state.nextRunAtMs).toBe(Date.parse("2026-03-23T07:00:00.000Z"));
  });
});
