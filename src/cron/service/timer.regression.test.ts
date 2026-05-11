import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDefaultIsolatedRunner,
  createDeferred,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { HEARTBEAT_SKIP_LANES_BUSY, type HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import * as schedule from "../schedule.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import { computeJobNextRunAtMs } from "./jobs.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  applyJobResult,
  executeJob,
  executeJobCore,
  onTimer,
  runMissedJobs,
} from "./timer.js";

const FAST_TIMEOUT_SECONDS = 1;
const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function firstMockArg(mock: unknown): unknown {
  const calls = (mock as { mock: { calls: readonly (readonly unknown[])[] } }).mock.calls;
  expect(calls[0]).toBeTruthy();
  return calls[0]?.[0];
}

describe("cron service timer regressions", () => {
  it("caps timer delay to 60s for far-future schedules", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = timerRegressionFixtures.makeStorePath();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    state.store = { version: 1, jobs: [] };
    await fs.writeFile(store.storePath, JSON.stringify(state.store), "utf8");

    state.store.jobs.push({
      id: "far-future",
      name: "far-future",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at", at: "2035-01-01T00:00:00.000Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "future" },
      state: { nextRunAtMs: Date.parse("2035-01-01T00:00:00.000Z") },
    });

    await onTimer(state);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays).toContain(60_000);
    timeoutSpy.mockRestore();
  });

  it("re-arms timer without hot-looping when a run is already in progress", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = timerRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      jobs: [createDueIsolatedJob({ id: "due", nowMs: now, nextRunAtMs: now - 1 })],
    });

    await onTimer(state);

    expect(timeoutSpy).toHaveBeenCalled();
    expect(state.timer).toBeTruthy();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);
    timeoutSpy.mockRestore();
  });

  it("#24355: one-shot job retries then succeeds", async () => {
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const runRetryScenario = async (params: {
      id: string;
      deleteAfterRun: boolean;
      firstError?: string;
    }) => {
      const store = timerRegressionFixtures.makeStorePath();
      const cronJob = createIsolatedRegressionJob({
        id: params.id,
        name: "reminder",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "remind me" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.deleteAfterRun = params.deleteAfterRun;
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const runIsolatedAgentJob = vi
        .fn()
        .mockResolvedValueOnce({
          status: "error",
          error: params.firstError ?? "429 rate limit exceeded",
        })
        .mockResolvedValueOnce({ status: "ok", summary: "done" });
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);
      const jobAfterRetry = requireJob(state, params.id);
      expect(jobAfterRetry.enabled).toBe(true);
      expect(jobAfterRetry.state.lastStatus).toBe("error");
      expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

      now = requireTimestamp(jobAfterRetry.state.nextRunAtMs, "retry next run") + 1;
      await onTimer(state);
      return { state, runIsolatedAgentJob };
    };

    const keepResult = await runRetryScenario({
      id: "oneshot-retry",
      deleteAfterRun: false,
    });
    const keepJob = keepResult.state.store?.jobs.find((j) => j.id === "oneshot-retry");
    expect(keepJob?.state.lastStatus).toBe("ok");
    expect(keepResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const deleteResult = await runRetryScenario({
      id: "oneshot-deleteAfterRun-retry",
      deleteAfterRun: true,
    });
    const deletedJob = deleteResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-deleteAfterRun-retry",
    );
    expect(deletedJob).toBeUndefined();
    expect(deleteResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const overloadedResult = await runRetryScenario({
      id: "oneshot-overloaded-retry",
      deleteAfterRun: false,
      firstError:
        "All models failed (2): anthropic/claude-3-5-sonnet: LLM error overloaded_error: overloaded (overloaded); openai/gpt-5.4: LLM error overloaded_error: overloaded (overloaded)",
    });
    const overloadedJob = overloadedResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-overloaded-retry",
    );
    expect(overloadedJob?.state.lastStatus).toBe("ok");
    expect(overloadedResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled after max transient retries", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-max-retries",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "429 rate limit exceeded",
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = requireJob(state, "oneshot-max-retries");
      if (i < 3) {
        expect(job.enabled).toBe(true);
        now = requireTimestamp(job.state.nextRunAtMs, "max-retries next run") + 1;
      } else {
        expect(job.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(4);
  });

  it("#24355: one-shot job respects cron.retry config", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-custom-retry",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "429 rate limit exceeded",
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 2, backoffMs: [1000, 2000] },
      },
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = requireJob(state, "oneshot-custom-retry");
      if (i < 2) {
        expect(job.enabled).toBe(true);
        now = requireTimestamp(job.state.nextRunAtMs, "custom-retry next run") + 1;
      } else {
        expect(job.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
  });

  it("#24355: one-shot job retries status-only 529 failures when retryOn only includes overloaded", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-overloaded-529-only",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", error: "FailoverError: HTTP 529" })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["overloaded"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = requireJob(state, "oneshot-overloaded-529-only");
    expect(jobAfterRetry.enabled).toBe(true);
    expect(jobAfterRetry.state.lastStatus).toBe("error");
    expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = requireTimestamp(jobAfterRetry.state.nextRunAtMs, "529 retry next run") + 1;
    await onTimer(state);

    const finishedJob = requireJob(state, "oneshot-overloaded-529-only");
    expect(finishedJob.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("retries OpenAI-compatible server_error payloads when retryOn only includes server_error", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-03-14T00:00:00.000Z");
    const serverErrorPayload =
      'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}';

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-server-error-only",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", error: serverErrorPayload })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["server_error"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = requireJob(state, "oneshot-server-error-only");
    expect(jobAfterRetry.enabled).toBe(true);
    expect(jobAfterRetry.state.lastStatus).toBe("error");
    expect(jobAfterRetry.state.lastErrorReason).toBe("server_error");
    expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = requireTimestamp(jobAfterRetry.state.nextRunAtMs, "server_error retry next run") + 1;
    await onTimer(state);

    const finishedJob = requireJob(state, "oneshot-server-error-only");
    expect(finishedJob.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#38822: one-shot job retries Bedrock too-many-tokens-per-day errors", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-03-08T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-bedrock-too-many-tokens-per-day",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({
        status: "error",
        error: "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
      })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["rate_limit"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = requireJob(state, "oneshot-bedrock-too-many-tokens-per-day");
    expect(jobAfterRetry.enabled).toBe(true);
    expect(jobAfterRetry.state.lastStatus).toBe("error");
    expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = requireTimestamp(jobAfterRetry.state.nextRunAtMs, "Bedrock retry next run") + 1;
    await onTimer(state);

    const finishedJob = requireJob(state, "oneshot-bedrock-too-many-tokens-per-day");
    expect(finishedJob.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled immediately on permanent error", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-permanent-error",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({
        status: "error",
        error: "invalid API key",
      }),
    });

    await onTimer(state);

    const job = requireJob(state, "oneshot-permanent-error");
    expect(job.enabled).toBe(false);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("prevents spin loop when cron job completes within the scheduled second (#17821)", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const nextDay = scheduledAt + 86_400_000;

    const cronJob = createIsolatedRegressionJob({
      id: "spin-loop-17821",
      name: "daily noon",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "briefing" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    let fireCount = 0;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 7;
        fireCount += 1;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);
    expect(fireCount).toBe(1);

    const job = requireJob(state, "spin-loop-17821");
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(nextDay);

    await onTimer(state);
    expect(fireCount).toBe(1);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "spin-gap-17821",
      name: "second-granularity",
      scheduledAt,
      schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "pulse" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);

    const job = requireJob(state, "spin-gap-17821");
    const endedAt = now;
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(endedAt + 2_000);
  });

  it("treats timeoutSeconds=0 as no timeout for isolated agentTurn jobs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "no-timeout-0",
      name: "no-timeout",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        const result = await deferredRun.promise;
        now += 5;
        return result;
      }),
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((entry) => entry.id === "no-timeout-0");
    expect(job?.state.lastStatus).toBe("ok");
  });

  it("does not time out agentTurn jobs at the default 10-minute safety window", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "agentturn-default-safety-window",
      name: "agentturn default safety window",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      const result = await deferredRun.promise;
      if (abortSignal?.aborted) {
        return { status: "error" as const, error: String(abortSignal.reason) };
      }
      now += 5;
      return result;
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_JOB_TIMEOUT_MS + 1_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((entry) => entry.id === "agentturn-default-safety-window");
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastError).toBeUndefined();
  });

  it("aborts isolated runs when cron timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "abort-on-timeout",
        name: "abort timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
      });

      const timerPromise = onTimer(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      await timerPromise;

      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "abort-on-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend isolated execution timeout while waiting for the runner lane (#41783)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-after-lane-start",
        name: "timeout after lane start",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const runnerEntered = createDeferred<void>();
      const laneAcquired = createDeferred<void>();
      let observedAbortSignal: AbortSignal | undefined;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
          observedAbortSignal = abortSignal;
          runnerEntered.resolve();
          await laneAcquired.promise;
          onExecutionStarted?.();
          await new Promise<void>((resolve) => {
            if (!abortSignal) {
              resolve();
              return;
            }
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          now += 5;
          return { status: "ok" as const, summary: "late" };
        }),
      });

      const timerPromise = onTimer(state);
      await runnerEntered.promise;
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      expect(observedAbortSignal?.aborted).toBe(false);

      laneAcquired.resolve();
      await Promise.resolve();
      expect(observedAbortSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      await timerPromise;

      expect(observedAbortSignal?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "timeout-after-lane-start");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses isolated follow-up side effects after timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const enqueueSystemEvent = vi.fn();

      const cronJob = createIsolatedRegressionJob({
        id: "timeout-side-effects",
        name: "timeout side effects",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner("late-summary");
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 100;
          return result;
        }),
      });

      const timerPromise = onTimer(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      await timerPromise;

      const jobAfterTimeout = state.store?.jobs.find(
        (entry) => entry.id === "timeout-side-effects",
      );
      expect(jobAfterTimeout?.state.lastStatus).toBe("error");
      expect(jobAfterTimeout?.state.lastError).toContain("timed out");
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies timeoutSeconds to startup catch-up isolated executions", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "startup-timeout",
        name: "startup timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
      });

      const catchupPromise = runMissedJobs(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      await catchupPromise;

      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "startup-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects abort signals while retrying one-shot main-session wake-now heartbeat runs", async () => {
    const abortController = new AbortController();
    const runHeartbeatOnce = vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        status: "skipped",
        reason: "requests-in-flight",
      }),
    );
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const mainJob: CronJob = {
      id: "main-abort",
      name: "main abort",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/openclaw-cron-abort-test/jobs.json",
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      wakeNowHeartbeatBusyMaxWaitMs: 30,
      wakeNowHeartbeatBusyRetryDelayMs: 5,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    setTimeout(() => {
      abortController.abort();
    }, 10);

    const resultPromise = executeJobCore(state, mainJob, abortController.signal);
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out");
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("retries recurring wake-now main jobs until temporary lane pressure clears (#75964)", async () => {
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };
    const runHeartbeatOnce = vi
      .fn<() => Promise<HeartbeatRunResult>>()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_LANES_BUSY })
      .mockResolvedValueOnce({ status: "ran", durationMs: 12 });
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const job: CronJob = {
      id: "busy-recurring-main",
      name: "busy recurring main",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "*/3 * * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: 0 },
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/openclaw-cron-busy-main-test/jobs.json",
      log: noopLogger,
      nowMs,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      wakeNowHeartbeatBusyMaxWaitMs: 120_000,
      wakeNowHeartbeatBusyRetryDelayMs: 1,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    state.store = { version: 1, jobs: [job] };

    const runPromise = executeJob(state, job, nowMs(), { forced: false });
    await vi.advanceTimersByTimeAsync(1);
    await runPromise;

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledTimes(2);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "retry-next-second-17821",
      name: "retry",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "briefing" },
    });

    const original = schedule.computeNextRunAtMs;
    const spy = vi.spyOn(schedule, "computeNextRunAtMs");
    try {
      spy
        .mockImplementationOnce(() => undefined)
        .mockImplementation((sched, nowMs) => original(sched, nowMs));

      const expected = requireTimestamp(
        original(cronJob.schedule, scheduledAt + 1_000),
        "next-second retry",
      );

      const next = computeJobNextRunAtMs(cronJob, scheduledAt);
      expect(next).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("records per-job start time and duration for batched due jobs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "batch-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({ id: "batch-second", nowMs: dueAt, nextRunAtMs: dueAt });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }),
      "utf-8",
    );

    let now = dueAt;
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent: (evt) => {
        events.push(evt);
      },
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        now += params.job.id === first.id ? 50 : 20;
        return { status: "ok" as const, summary: "ok" };
      }),
    });

    await onTimer(state);

    const jobs = state.store?.jobs ?? [];
    const firstDone = jobs.find((job) => job.id === first.id);
    const secondDone = jobs.find((job) => job.id === second.id);
    const startedAtEvents = events
      .filter((evt) => evt.action === "started")
      .map((evt) => evt.runAtMs);

    expect(firstDone?.state.lastRunAtMs).toBe(dueAt);
    expect(firstDone?.state.lastDurationMs).toBe(50);
    expect(secondDone?.state.lastRunAtMs).toBe(dueAt + 50);
    expect(secondDone?.state.lastDurationMs).toBe(20);
    expect(startedAtEvents).toEqual([dueAt, dueAt + 50]);
  });

  it("honors cron maxConcurrentRuns for due jobs", async () => {
    vi.useRealTimers();
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "parallel-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({
      id: "parallel-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }),
      "utf-8",
    );

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred<void>();
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 2 },
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        if (peakActiveRuns >= 2) {
          bothRunsStarted.resolve();
        }
        try {
          const result =
            params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
          now += 10;
          return result;
        } finally {
          activeRuns -= 1;
        }
      }),
    });

    const timerPromise = onTimer(state);
    const startTimeout = setTimeout(() => {
      bothRunsStarted.reject(new Error("timed out waiting for concurrent job starts"));
    }, 250);
    try {
      await bothRunsStarted.promise;
    } finally {
      clearTimeout(startTimeout);
    }

    expect(peakActiveRuns).toBe(2);

    firstRun.resolve({ status: "ok", summary: "first done" });
    secondRun.resolve({ status: "ok", summary: "second done" });
    await timerPromise;

    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
  });

  it("finalizes a successful isolated job that removes itself during execution", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const selfRemovingJob = createDueIsolatedJob({
      id: "self-removing-success",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    selfRemovingJob.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "chat-123",
    };
    await writeCronJobs(store.storePath, [selfRemovingJob]);

    const events: CronEvent[] = [];
    const log = {
      ...noopLogger,
      warn: vi.fn(),
      info: vi.fn(),
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent: (evt) => {
        events.push(evt);
      },
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        await fs.writeFile(store.storePath, JSON.stringify({ version: 1, jobs: [] }), "utf-8");
        return {
          status: "ok" as const,
          summary: `finished ${params.job.id}`,
          delivered: true,
        };
      }),
    });

    await onTimer(state);

    expect(state.store?.jobs).toStrictEqual([]);
    expect(
      log.warn.mock.calls.some(
        ([, message]) =>
          message ===
          "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
      ),
    ).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      { jobId: selfRemovingJob.id },
      "cron: finalized successful run after job was removed during execution",
    );
    const event = events.find(
      (candidate) => candidate.jobId === selfRemovingJob.id && candidate.action === "finished",
    );
    expect(event).toBeTruthy();
    expect(event?.action).toBe("finished");
    expect(event?.status).toBe("ok");
    expect(event?.summary).toBe(`finished ${selfRemovingJob.id}`);
    expect(event?.delivered).toBe(true);
    expect(event?.deliveryStatus).toBe("delivered");
  });

  it("keeps missing-job discard semantics for failed isolated outcomes", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const failedJob = createDueIsolatedJob({
      id: "self-removing-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await writeCronJobs(store.storePath, [failedJob]);

    const events: CronEvent[] = [];
    const log = {
      ...noopLogger,
      warn: vi.fn(),
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent: (evt) => {
        events.push(evt);
      },
      runIsolatedAgentJob: vi.fn(async () => {
        await fs.writeFile(store.storePath, JSON.stringify({ version: 1, jobs: [] }), "utf-8");
        return { status: "error" as const, error: "agent failed after removal" };
      }),
    });

    await onTimer(state);

    expect(state.store?.jobs).toStrictEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      { jobId: failedJob.id },
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
    expect(
      events.some(
        (evt) => evt.jobId === failedJob.id && evt.action === "finished" && evt.status === "error",
      ),
    ).toBe(false);
  });

  it("outer cron timeout fires at configured timeoutSeconds, not at 1/3 (#29774)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const timeoutSeconds = 1;
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-fraction-29774",
        name: "timeout fraction regression",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const wallStart = Date.now();
      let abortWallMs: number | undefined;
      const started = createDeferred<void>();

      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(
          async ({
            abortSignal,
            onExecutionStarted,
          }: {
            abortSignal?: AbortSignal;
            onExecutionStarted?: () => void;
          }) => {
            onExecutionStarted?.();
            started.resolve();
            await new Promise<void>((resolve) => {
              if (!abortSignal) {
                resolve();
                return;
              }
              if (abortSignal.aborted) {
                abortWallMs = Date.now();
                resolve();
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => {
                  abortWallMs = Date.now();
                  resolve();
                },
                { once: true },
              );
            });
            now += 5;
            return { status: "ok" as const, summary: "done" };
          },
        ),
      });

      const timerPromise = onTimer(state);
      await started.promise;

      await vi.advanceTimersByTimeAsync(500);
      expect(abortWallMs).toBeUndefined();

      await vi.advanceTimersByTimeAsync(600);
      await timerPromise;

      const elapsedMs = (abortWallMs ?? Date.now()) - wallStart;
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutSeconds * 1_000);

      const job = state.store?.jobs.find((entry) => entry.id === "timeout-fraction-29774");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timed-out isolated runs even when the runner ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T14:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-cleanup-stuck-run",
        name: "timeout cleanup stuck run",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(
          async ({
            abortSignal,
            onExecutionStarted,
          }: {
            abortSignal?: AbortSignal;
            onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
          }) => {
            onExecutionStarted?.({
              jobId: "timeout-cleanup-stuck-run",
              agentId: "main",
              sessionId: "cron-run-session",
              sessionKey: "agent:main:cron:timeout-cleanup-stuck-run:run:cron-run-session",
            });
            started.resolve();
            abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
              },
              { once: true },
            );
            return await new Promise<never>(() => {});
          },
        ),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_100);
      now += 1_100;
      await timerPromise;

      expect(abortObserved).toBe(true);
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      const cleanupArgs = requireRecord(firstMockArg(cleanupTimedOutAgentRun));
      expect(requireRecord(cleanupArgs.job).id).toBe("timeout-cleanup-stuck-run");
      expect(cleanupArgs.timeoutMs).toBe(1_000);
      expect(cleanupArgs.execution).toEqual({
        jobId: "timeout-cleanup-stuck-run",
        agentId: "main",
        sessionId: "cron-run-session",
        sessionKey: "agent:main:cron:timeout-cleanup-stuck-run:run:cron-run-session",
      });
      const job = state.store?.jobs.find((entry) => entry.id === "timeout-cleanup-stuck-run");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out isolated agent setup before the runner start callback (#74803)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T09:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "isolated-setup-timeout-74803",
        name: "setup timeout regression",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          started.resolve();
          abortSignal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
            },
            { once: true },
          );
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      const job = requireJob(state, "isolated-setup-timeout-74803");
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("setup timed out before runner start");
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      const cleanupArgs = requireRecord(firstMockArg(cleanupTimedOutAgentRun));
      expect(requireRecord(cleanupArgs.job).id).toBe("isolated-setup-timeout-74803");
      expect(cleanupArgs.timeoutMs).toBe(120_000);
      expect(cleanupArgs.execution).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out isolated agent runs that stall before execution starts (#74803)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T09:05:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "isolated-pre-model-timeout-74803",
        name: "pre model timeout regression",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1_200 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(
          async ({
            abortSignal,
            onExecutionStarted,
            onExecutionPhase,
          }: {
            abortSignal?: AbortSignal;
            onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
            onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
          }) => {
            onExecutionStarted?.({
              jobId: "isolated-pre-model-timeout-74803",
              agentId: "main",
              sessionId: "cron-run-session",
              sessionKey: "agent:main:cron:isolated-pre-model-timeout-74803:run:cron-run-session",
              phase: "runner_entered",
            });
            onExecutionPhase?.({
              jobId: "isolated-pre-model-timeout-74803",
              agentId: "main",
              sessionId: "cron-run-session",
              sessionKey: "agent:main:cron:isolated-pre-model-timeout-74803:run:cron-run-session",
              phase: "context_engine",
            });
            started.resolve();
            abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
              },
              { once: true },
            );
            return await new Promise<never>(() => {});
          },
        ),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      const job = requireJob(state, "isolated-pre-model-timeout-74803");
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("stalled before execution start");
      expect(job.state.lastError).toContain("context-engine");
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      const cleanupArgs = requireRecord(firstMockArg(cleanupTimedOutAgentRun));
      expect(requireRecord(cleanupArgs.job).id).toBe("isolated-pre-model-timeout-74803");
      expect(cleanupArgs.timeoutMs).toBe(1_200_000);
      const execution = requireRecord(cleanupArgs.execution);
      expect(execution.jobId).toBe("isolated-pre-model-timeout-74803");
      expect(execution.phase).toBe("context_engine");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pre-execution watchdog on explicit execution milestones (#80283)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T09:10:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "isolated-turn-accepted-80283",
        name: "turn accepted regression",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1_200 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(
          async ({
            abortSignal,
            onExecutionStarted,
            onExecutionPhase,
          }: {
            abortSignal?: AbortSignal;
            onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
            onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
          }) => {
            onExecutionStarted?.({
              jobId: "isolated-turn-accepted-80283",
              phase: "runner_entered",
            });
            onExecutionPhase?.({
              jobId: "isolated-turn-accepted-80283",
              phase: "turn_accepted",
              backend: "codex-app-server",
            });
            started.resolve();
            abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
              },
              { once: true },
            );
            return await new Promise<never>(() => {});
          },
        ),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      expect(abortObserved).toBe(false);
      expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_140_000);
      now += 1_140_000;
      await timerPromise;

      const job = requireJob(state, "isolated-turn-accepted-80283");
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("job execution timed out");
      expect(job.state.lastError).toContain("turn-accepted");
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps state updates when cron next-run computation throws after a successful run (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:00:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-30905-success.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-success-30905",
      name: "apply-result-success-30905",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      status: "ok",
      delivered: true,
      startedAt,
      endedAt,
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.enabled).toBe(true);
  });

  it("keeps state updates when cron next-run computation throws on error path (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:05:00.000Z");
    const endedAt = startedAt + 25;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-30905-error.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-error-30905",
      name: "apply-result-error-30905",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      status: "error",
      error: "synthetic failure",
      startedAt,
      endedAt,
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.enabled).toBe(true);
  });

  it("does not synthesize a 2s retry when cron schedule computation returns undefined (#66019)", () => {
    const startedAt = Date.parse("2026-04-13T15:40:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-66019-success.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "cron-66019-success",
      name: "cron-66019-success",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);

    try {
      const shouldDelete = applyJobResult(state, job, {
        status: "ok",
        delivered: true,
        startedAt,
        endedAt,
      });

      expect(shouldDelete).toBe(false);
      expect(job.state.runningAtMs).toBeUndefined();
      expect(job.state.lastRunAtMs).toBe(startedAt);
      expect(job.state.lastStatus).toBe("ok");
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.enabled).toBe(true);
    } finally {
      nextRunSpy.mockRestore();
    }
  });

  it("does not synthesize backoff retries when cron schedule computation returns undefined (#66019)", () => {
    const startedAt = Date.parse("2026-04-13T15:45:00.000Z");
    const endedAt = startedAt + 25;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-66019-error.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "cron-66019-error",
      name: "cron-66019-error",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);

    try {
      const shouldDelete = applyJobResult(state, job, {
        status: "error",
        error: "synthetic failure",
        startedAt,
        endedAt,
      });

      expect(shouldDelete).toBe(false);
      expect(job.state.runningAtMs).toBeUndefined();
      expect(job.state.lastRunAtMs).toBe(startedAt);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.consecutiveErrors).toBe(1);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.enabled).toBe(true);
    } finally {
      nextRunSpy.mockRestore();
    }
  });

  it("force run preserves 'every' anchor while recording manual lastRunAtMs", () => {
    const nowMs = Date.now();
    const everyMs = 24 * 60 * 60 * 1_000;
    const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1_000;
    const expectedNextMs = lastScheduledRunMs + everyMs;

    const job: CronJob = {
      id: "daily-job",
      name: "Daily job",
      enabled: true,
      createdAtMs: lastScheduledRunMs - everyMs,
      updatedAtMs: lastScheduledRunMs,
      schedule: { kind: "every", everyMs, anchorMs: lastScheduledRunMs - everyMs },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "daily check-in" },
      state: {
        lastRunAtMs: lastScheduledRunMs,
        nextRunAtMs: expectedNextMs,
      },
    };
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-force-run-anchor-test.json",
      log: noopLogger,
      nowMs: () => nowMs,
      jobs: [job],
    });

    const startedAt = nowMs;
    const endedAt = nowMs + 2_000;

    applyJobResult(state, job, { status: "ok", startedAt, endedAt }, { preserveSchedule: true });

    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.nextRunAtMs).toBe(expectedNextMs);
  });

  it("persists and warns with last cron run diagnostics", () => {
    const startedAt = Date.parse("2026-04-14T12:00:00.000Z");
    const endedAt = startedAt + 500;
    const job = createIsolatedRegressionJob({
      id: "diagnostics-job",
      name: "diagnostics-job",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "diagnose" },
      state: { runningAtMs: startedAt },
    });
    const log = { ...noopLogger, warn: vi.fn() };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-diagnostics-job.json",
      log,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    applyJobResult(state, job, {
      status: "error",
      error: "failed",
      diagnostics: {
        summary: "exec stderr tail",
        entries: [
          {
            ts: startedAt,
            source: "exec",
            severity: "error",
            message: "exec stderr tail",
            exitCode: 1,
          },
        ],
      },
      startedAt,
      endedAt,
    });

    expect(job.state.lastDiagnostics?.summary).toBe("exec stderr tail");
    expect(job.state.lastDiagnostics?.entries).toEqual([
      {
        ts: startedAt,
        source: "exec",
        severity: "error",
        message: "exec stderr tail",
        exitCode: 1,
      },
    ]);
    expect(job.state.lastDiagnosticSummary).toBe("exec stderr tail");
    expect(log.warn).toHaveBeenCalledWith(
      {
        jobId: "diagnostics-job",
        jobName: "diagnostics-job",
        error: "failed",
        diagnosticsSummary: "exec stderr tail",
      },
      "cron: job run returned error status",
    );
  });
});
