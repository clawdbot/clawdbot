import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a one-shot main job and disables it after success", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      name: "one-shot hello",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello");
    expect(requestHeartbeatNow).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("wakeMode now waits for heartbeat completion when available", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    let resolveHeartbeat: ((res: HeartbeatRunResult) => void) | null = null;
    const runHeartbeatOnce = vi.fn(
      async () =>
        await new Promise<HeartbeatRunResult>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "wakeMode now waits",
      enabled: true,
      schedule: { kind: "at", atMs: 1 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const runPromise = cron.run(job.id, "force");
    for (let i = 0; i < 10; i++) {
      if (runHeartbeatOnce.mock.calls.length > 0) break;
      // Let the locked() chain progress.
      await Promise.resolve();
    }

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello");
    expect(job.state.runningAtMs).toBeTypeOf("number");

    resolveHeartbeat?.({ status: "ran", durationMs: 123 });
    await runPromise;

    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeGreaterThan(0);

    cron.stop();
    await store.cleanup();
  });

  it("runs an isolated job and posts summary to main", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      name: "weekly",
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it", deliver: false },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    await cron.list({ includeDisabled: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Cron: done");
    expect(requestHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("migrates legacy payload.channel to payload.provider on load", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const rawJob = {
      id: "legacy-1",
      name: "legacy",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: " TeLeGrAm ",
        to: "7200373102",
      },
      state: {},
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [rawJob] }, null, 2),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === rawJob.id);
    const payload = job?.payload as unknown as Record<string, unknown>;
    expect(payload.provider).toBe("telegram");
    expect("channel" in payload).toBe(false);

    cron.stop();
    await store.cleanup();
  });

  it("canonicalizes payload.provider casing on load", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const rawJob = {
      id: "legacy-2",
      name: "legacy",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        provider: "Telegram",
        to: "7200373102",
      },
      state: {},
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [rawJob] }, null, 2),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === rawJob.id);
    const payload = job?.payload as unknown as Record<string, unknown>;
    expect(payload.provider).toBe("telegram");

    cron.stop();
    await store.cleanup();
  });

  it("posts last output to main even when isolated job errors", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      name: "isolated error test",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it", deliver: false },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await cron.list({ includeDisabled: true });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Cron (error): last output",
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated cron jobs require/);

    cron.stop();
    await store.cleanup();
  });

  it("skips invalid main jobs with agentTurn payloads from disk", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            enabled: true,
            createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
            updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
            schedule: { kind: "at", atMs },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "bad" },
            state: {},
          },
        ],
      }),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main job requires/i);

    cron.stop();
    await store.cleanup();
  });

  it("skips main jobs with empty systemEvent text", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      name: "empty systemEvent test",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "   " },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/non-empty/i);

    cron.stop();
    await store.cleanup();
  });

  it("does not schedule timers when cron is disabled", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: false,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      name: "disabled cron job",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const status = await cron.status();
    expect(status.enabled).toBe(false);
    expect(status.nextWakeAtMs).toBeNull();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("status reports next wake when enabled", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:05.000Z");
    await cron.add({
      name: "status next wake",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const status = await cron.status();
    expect(status.enabled).toBe(true);
    expect(status.jobs).toBe(1);
    expect(status.nextWakeAtMs).toBe(atMs);

    cron.stop();
    await store.cleanup();
  });
});
