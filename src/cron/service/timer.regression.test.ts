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
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import * as schedule from "../schedule.js";
import type { CronJob } from "../types.js";
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

describe("cron service timer regressions", () => {
  it("caps timer delay to 60s for far-future schedules", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = timerRegressionFixtures.makeStorePath();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
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
    expect(state.timer).not.toBeNull();
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
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);
      const jobAfterRetry = state.store?.jobs.find((j) => j.id === params.id);
      expect(jobAfterRetry).toBeDefined();
      expect(jobAfterRetry!.enabled).toBe(true);
      expect(jobAfterRetry!.state.lastStatus).toBe("error");
      expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

      now = (jobAfterRetry!.state.nextRunAtMs ?? 0) + 1;
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-max-retries");
      expect(job).toBeDefined();
      if (i < 3) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 2, backoffMs: [1000, 2000] },
      },
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-custom-retry");
      expect(job).toBeDefined();
      if (i < 2) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["overloaded"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(finishedJob!.state.lastStatus).toBe("ok");
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["rate_limit"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(finishedJob!.state.lastStatus).toBe("ok");
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({
        status: "error",
        error: "invalid API key",
      }),
    });

    await onTimer(state);

    const job = state.store?.jobs.find((j) => j.id === "oneshot-permanent-error");
    expect(job!.enabled).toBe(false);
    expect(job!.state.lastStatus).toBe("error");
    expect(job!.state.nextRunAtMs).toBeUndefined();
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 7;
        fireCount += 1;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);
    expect(fireCount).toBe(1);

    const job = state.store?.jobs.find((entry) => entry.id === "spin-loop-17821");
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(nextDay);

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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);

    const job = state.store?.jobs.find((entry) => entry.id === "spin-gap-17821");
    const endedAt = now;
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(endedAt + 2_000);
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
      requestHeartbeatNow: vi.fn(),
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
      requestHeartbeatNow: vi.fn(),
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
        requestHeartbeatNow: vi.fn(),
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
        requestHeartbeatNow: vi.fn(),
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
        requestHeartbeatNow: vi.fn(),
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
    const requestHeartbeatNow = vi.fn();
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
      requestHeartbeatNow,
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
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("finishes recurring wake-now main jobs quickly when the main lane is busy (#58833)", async () => {
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };
    const runHeartbeatOnce = vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        status: "skipped",
        reason: "requests-in-flight",
      }),
    );
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
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
      requestHeartbeatNow,
      runHeartbeatOnce,
      wakeNowHeartbeatBusyMaxWaitMs: 120_000,
      wakeNowHeartbeatBusyRetryDelayMs: 250,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    state.store = { version: 1, jobs: [job] };

    await executeJob(state, job, nowMs(), { forced: false });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cron:busy-recurring-main" }),
    );
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeLessThan(100);
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

      const expected = original(cronJob.schedule, scheduledAt + 1_000);
      expect(expected).toBeDefined();

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
      requestHeartbeatNow: vi.fn(),
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
      requestHeartbeatNow: vi.fn(),
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
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
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
        }),
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

  it("keeps state updates when cron next-run computation throws after a successful run (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:00:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-30905-success.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
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
      requestHeartbeatNow: vi.fn(),
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
      requestHeartbeatNow: vi.fn(),
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
      requestHeartbeatNow: vi.fn(),
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
});
