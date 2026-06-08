// Cron service timer tests cover timer scheduling, cancellation, and wakeups.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSessionStoreForTestAsync } from "../../config/sessions/test-helpers.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { executeJobCore, onTimer } from "../../cron/service/timer.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import * as detachedTaskRuntime from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";

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

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return {
    id: "isolated-agent-job",
    agentId: "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueCommandJob(params: { now: number }): CronJob {
  return {
    id: "command-job",
    agentId: "finn",
    name: "command job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
    state: { nextRunAtMs: params.now - 1 },
  };
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("routes main cron jobs onto a cron run lane derived from the target agent", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const job = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      sessionKey: "agent:main-pr-router:main",
      state: { runningAtMs: now },
    };
    const cronRunSessionKey = `agent:main-pr-router:cron:main-heartbeat-job:run:${now}`;
    const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
    await writeSessionStoreForTestAsync(sessionStorePath, {
      "agent:main-pr-router:main": {
        lastChannel: "discord",
        lastTo: "channel-1",
        lastAccountId: "default",
      },
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      resolveSessionStorePath: () => sessionStorePath,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok", sessionKey: cronRunSessionKey });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      contextKey: "cron:main-heartbeat-job",
      deliveryContext: { channel: "discord", to: "channel-1", accountId: "default" },
    });
    expect(runHeartbeatOnce).toHaveBeenCalledWith({
      source: "cron",
      intent: "immediate",
      reason: "cron:main-heartbeat-job",
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      heartbeat: { target: "last" },
    });
  });

  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
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
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    const cronRunSessionKey = `agent:main:cron:main-heartbeat-job:run:${now}`;
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "cron",
      intent: "event",
      reason: "cron:main-heartbeat-job",
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      heartbeat: { target: "last" },
    });

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted heartbeat cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
    const task = findTaskByRunId(`cron:main-heartbeat-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.runtime).toBe("cron");
    expect(task.sourceId).toBe("main-heartbeat-job");
    expect(task.ownerKey).toBe("");
    expect(task.scopeKind).toBe("system");
    expect(task.childSessionKey).toBe(cronRunSessionKey);
    expect(task.runId).toBe(`cron:main-heartbeat-job:${now}`);
    expect(task.label).toBe("main heartbeat job");
    expect(task.task).toBe("main heartbeat job");
    expect(task.status).toBe("succeeded");
    expect(task.deliveryStatus).toBe("not_applicable");
    expect(task.notifyPolicy).toBe("silent");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task?.cleanupAfter).toBe(now + 7 * 24 * 60 * 60_000);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
  });

  it("runs command cron jobs without isolated agent setup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const runCommandJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "command ok",
    }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      runCommandJob,
    });
    const job = createDueCommandJob({ now });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok", summary: "command ok" });
    expect(runCommandJob).toHaveBeenCalledWith({
      job,
      abortSignal: undefined,
    });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-agent-job" }),
        message: "run isolated cron",
      }),
    );
    const task = findTaskByRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job");
    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("done");
  });

  it("seeds active scheduled cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    const runIsolatedAgentJob = vi.fn(
      () =>
        new Promise<{ status: "ok"; summary: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    });

    const task = findTaskByRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected active cron task ledger record");
    }
    expect(task.status).toBe("running");
    expect(task.progressSummary).toBe("Running cron job.");
    expect(formatTaskStatusDetail(task)).toBe("Running cron job.");

    resolveRun?.({ status: "ok", summary: "done" });
    await timerRun;
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const ledgerError = new Error("disk full");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementation(() => {
        throw ledgerError;
      });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: "main-heartbeat-job", error: ledgerError },
      "cron: failed to create task ledger record",
    );
    const cronRunSessionKey = `agent:main:cron:main-heartbeat-job:run:${now}`;
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: cronRunSessionKey,
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});
