// Cron read operation tests cover nonblocking list/get behavior during service work.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../utils/with-timeout.js";
import { CronService } from "./service.js";
import { writeCronStoreSnapshot } from "./service.test-harness.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type IsolatedRunResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      // On macOS, teardown can race with trailing async fs writes and leave
      // transient ENOTEMPTY/EBUSY errors; let fs.rm handle retries natively.
      try {
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 10,
        });
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function createDeferredIsolatedRun() {
  let resolveRun: ((value: IsolatedRunResult) => void) | undefined;
  let resolveRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve;
  });
  const runIsolatedAgentJob = vi.fn(async () => {
    resolveRunStarted?.();
    return await new Promise<IsolatedRunResult>((resolve) => {
      resolveRun = resolve;
    });
  });
  return {
    runIsolatedAgentJob,
    runStarted,
    completeRun: (result: IsolatedRunResult) => {
      resolveRun?.(result);
    },
  };
}

function expectCronStatus(
  status: Awaited<ReturnType<CronService["status"]>>,
  params: { jobs: number },
) {
  expect(status.enabled).toBe(true);
  expect(status.storage).toBe("sqlite");
  expect(status.sqlitePath).toContain("openclaw.sqlite");
  expect(status.storePath).toBe(status.sqlitePath);
  expect(status.jobs).toBe(params.jobs);
  if (status.nextWakeAtMs !== null) {
    expect(status.nextWakeAtMs).toBeTypeOf("number");
  }
}

describe("CronService read ops while job is running", () => {
  it.each([
    { deleteAfterRun: true, status: "ok" },
    { deleteAfterRun: false, status: "ok" },
    { deleteAfterRun: true, status: "error" },
    { deleteAfterRun: false, status: "error" },
    { deleteAfterRun: true, status: "skipped" },
    { deleteAfterRun: false, status: "skipped" },
  ] as const)(
    "preserves a rescheduled active one-shot after $status and restart (deleteAfterRun=$deleteAfterRun)",
    async ({ deleteAfterRun, status }) => {
      vi.useFakeTimers();
      const startedAt = Date.parse("2025-12-13T00:00:01.000Z");
      const rescheduledAt = startedAt + 5 * 60_000;
      vi.setSystemTime(startedAt - 1_000);
      const store = await makeStorePath();
      const isolatedRun = createDeferredIsolatedRun();
      let resolveFinished: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.action === "finished" && event.status === status) {
            resolveFinished?.();
          }
        },
      });
      let restartedCron: CronService | undefined;

      try {
        await cron.start();
        const job = await cron.add({
          name: "rescheduled active one-shot",
          enabled: true,
          deleteAfterRun,
          schedule: { kind: "at", at: new Date(startedAt).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "long task" },
          delivery: { mode: "none" },
        });

        vi.setSystemTime(startedAt);
        await vi.advanceTimersByTimeAsync(1_000);
        await isolatedRun.runStarted;

        await cron.update(job.id, {
          schedule: { kind: "at", at: new Date(rescheduledAt).toISOString() },
        });
        isolatedRun.completeRun({
          status,
          ...(status === "error" ? { error: "original invocation failed" } : {}),
        });
        await finished;
        await cron.status();

        const expected = {
          id: job.id,
          enabled: true,
          schedule: { kind: "at", at: new Date(rescheduledAt).toISOString() },
          state: { lastStatus: status, nextRunAtMs: rescheduledAt },
        };
        const completed = await cron.list({ includeDisabled: true });
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject(expected);

        cron.stop();
        restartedCron = new CronService({
          storePath: store.storePath,
          cronEnabled: true,
          log: noopLogger,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        await restartedCron.start();

        const restarted = await restartedCron.list({ includeDisabled: true });
        expect(restarted).toHaveLength(1);
        expect(restarted[0]).toMatchObject(expected);
      } finally {
        cron.stop();
        restartedCron?.stop();
        vi.clearAllTimers();
        vi.useRealTimers();
        await store.cleanup();
      }
    },
  );

  it("keeps list and status responsive during a long isolated run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.status === "ok") {
          resolveFinished?.();
        }
      },
    });

    try {
      await cron.start();

      // Schedule the job a second in the future; then jump time to trigger the tick.
      await cron.add({
        name: "slow isolated",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2025-12-13T00:00:01.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "long task" },
        delivery: { mode: "none" },
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.advanceTimersByTimeAsync(1_000);

      await isolatedRun.runStarted;
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(cron.list({ includeDisabled: true })).resolves.toHaveLength(1);
      expectCronStatus(await cron.status(), { jobs: 1 });

      const running = await cron.list({ includeDisabled: true });
      expect(running[0]?.state.runningAtMs).toBeTypeOf("number");

      isolatedRun.completeRun({ status: "ok", summary: "done" });

      // Wait until the scheduler writes the result back to the store.
      await finished;
      // Ensure any trailing store writes have finished before cleanup.
      await cron.status();

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");

      // Ensure the scheduler loop has fully settled before deleting the store directory.
      const internal = cron as unknown as { state?: { running?: boolean } };
      for (let i = 0; i < 100; i += 1) {
        if (!internal.state?.running) {
          break;
        }
        await Promise.resolve();
      }
      expect(internal.state?.running).toBe(false);
    } finally {
      cron.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
      await store.cleanup();
    }
  });

  it.each([true, false])(
    "preserves an A→B→A schedule edit during a manual run (deleteAfterRun=%s)",
    async (deleteAfterRun) => {
      const store = await makeStorePath();
      const isolatedRun = createDeferredIsolatedRun();
      const originalAt = Date.parse("2030-01-01T00:05:00.000Z");
      const intermediateAt = Date.parse("2030-01-01T00:10:00.000Z");
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      });
      let restartedCron: CronService | undefined;

      try {
        await cron.start();
        const job = await cron.add({
          name: "manual reschedule ownership",
          enabled: true,
          deleteAfterRun,
          schedule: { kind: "at", at: new Date(originalAt).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "manual task" },
          delivery: { mode: "none" },
        });

        const run = cron.run(job.id, "force");
        await isolatedRun.runStarted;
        await cron.update(job.id, {
          schedule: { kind: "at", at: new Date(intermediateAt).toISOString() },
        });
        await cron.update(job.id, {
          schedule: { kind: "at", at: new Date(originalAt).toISOString() },
        });
        isolatedRun.completeRun({ status: "ok", summary: "done" });
        await expect(run).resolves.toEqual({ ok: true, ran: true });

        const expected = {
          id: job.id,
          enabled: true,
          schedule: { kind: "at", at: new Date(originalAt).toISOString() },
          state: { lastStatus: "ok", nextRunAtMs: originalAt },
        };
        const completed = await cron.list({ includeDisabled: true });
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject(expected);

        cron.stop();
        restartedCron = new CronService({
          storePath: store.storePath,
          cronEnabled: true,
          log: noopLogger,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        await restartedCron.start();

        const restarted = await restartedCron.list({ includeDisabled: true });
        expect(restarted).toHaveLength(1);
        expect(restarted[0]).toMatchObject(expected);
      } finally {
        cron.stop();
        restartedCron?.stop();
        await store.cleanup();
      }
    },
  );

  it("keeps list and status responsive during manual cron.run execution", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "manual run isolation",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "manual run" },
        delivery: { mode: "none" },
      });

      const runPromise = cron.run(job.id, "force");
      await isolatedRun.runStarted;

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, {
          message: "cron.list during cron.run timed out",
        }),
      ).resolves.toHaveLength(1);
      expectCronStatus(
        await withTimeout(cron.status(), 300, {
          message: "cron.status during cron.run timed out",
        }),
        {
          jobs: 1,
        },
      );

      isolatedRun.completeRun({ status: "ok", summary: "manual done" });
      await expect(runPromise).resolves.toEqual({ ok: true, ran: true });

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");
      expect(completed[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive after startup defers catch-up runs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "startup-catchup",
          name: "startup catch-up",
          enabled: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "at", at: new Date(nowMs - 60_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "startup replay" },
          delivery: { mode: "none" },
          state: { nextRunAtMs: nowMs - 60_000 },
        },
      ],
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      startupDeferredMissedAgentJobDelayMs: 120_000,
    });

    try {
      await cron.start();
      expect(isolatedRun.runIsolatedAgentJob).not.toHaveBeenCalled();

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, {
          message: "cron.list during startup timed out",
        }),
      ).resolves.toHaveLength(1);
      expectCronStatus(
        await withTimeout(cron.status(), 300, {
          message: "cron.status during startup timed out",
        }),
        {
          jobs: 1,
        },
      );

      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBeUndefined();
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(jobs[0]?.state.nextRunAtMs).toBe(nowMs + 120_000);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
