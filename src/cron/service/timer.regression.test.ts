// Timer regression tests cover historical cron timer scheduling failures.
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
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { HEARTBEAT_SKIP_LANES_BUSY, type HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { cancelTaskById, listTaskRecords } from "../../tasks/task-registry.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronJobActive,
  markCronJobActive,
} from "../active-jobs.js";
import * as schedule from "../schedule.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type {
  CronAgentExecutionPhase,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import { cancelActiveCronTaskRun } from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { computeJobNextRunAtMs, recomputeNextRunsForMaintenance } from "./jobs.js";
import { run as runManualCronJob, stop } from "./ops.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import { applyJobResult, executeJobCoreWithTimeout, runMissedJobs } from "./timer.js";
import { executeJobCore, onTimer } from "./timer.test-support.js";

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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function firstMockArg(mock: unknown): unknown {
  const calls = (mock as { mock: { calls: readonly (readonly unknown[])[] } }).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return listTaskRecords().find(
    (entry) =>
      entry.runtime === "cron" &&
      (entry.runId === baseRunId || entry.runId?.startsWith(`${baseRunId}:`)),
  );
}

function installCronCancellationControlRuntime() {
  setTaskRegistryControlRuntimeForTests({
    cancelActiveCronTaskRun,
    getAcpSessionManager: () => ({
      cancelSession: async () => {
        throw new Error("Unexpected ACP cancellation");
      },
    }),
    killSubagentRunAdmin: async () => {
      throw new Error("Unexpected subagent cancellation");
    },
  });
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
    await saveCronStore(store.storePath, state.store);

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
    if (state.timer == null) {
      throw new Error("Expected cron timer to be re-armed");
    }
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const now = scheduledAt;
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

  it("retries recurring jobs after transient model rate limits before the next scheduled slot", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-29T02:28:00.000Z");
    const everySixHoursMs = 6 * 60 * 60 * 1_000;

    const cronJob = createIsolatedRegressionJob({
      id: "recurring-rate-limit-retry",
      name: "Clawsweeper 6h closure report",
      scheduledAt,
      schedule: { kind: "every", everyMs: everySixHoursMs, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "closure report" },
      state: { nextRunAtMs: scheduledAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({
        status: "error",
        error:
          "FailoverError: stream disconnected before completion: Rate limit reached for gpt-5.5 in organization org-test on tokens per min (TPM): Limit 40000000, Used 40000000, Requested 15773. Please try again in 23ms.",
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
    const jobAfterRetry = requireJob(state, "recurring-rate-limit-retry");
    expect(jobAfterRetry.enabled).toBe(true);
    expect(jobAfterRetry.state.lastStatus).toBe("error");
    expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);
    expect(jobAfterRetry.state.nextRunAtMs).toBeLessThan(scheduledAt + everySixHoursMs);
    expect(Object.keys(jobAfterRetry.state)).not.toContain("recurringRetryNextRunAtMs");
    expect(Object.keys(jobAfterRetry.state)).not.toContain("recurringRetryScheduleIdentity");

    now = requireTimestamp(jobAfterRetry.state.nextRunAtMs, "recurring retry next run") + 1;
    await onTimer(state);

    const finishedJob = requireJob(state, "recurring-rate-limit-retry");
    expect(finishedJob.state.lastStatus).toBe("ok");
    expect(finishedJob.state.nextRunAtMs).toBe(scheduledAt + everySixHoursMs);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("retries recurring jobs after isolated setup timeouts before the next scheduled slot", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-06-08T13:00:00.000Z");
    const everySixHoursMs = 6 * 60 * 60 * 1_000;

    const cronJob = createIsolatedRegressionJob({
      id: "recurring-setup-timeout-retry",
      name: "ShadowTrader Auto Channel Bug Monitor",
      scheduledAt,
      schedule: { kind: "every", everyMs: everySixHoursMs, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "monitor bugs" },
      state: { nextRunAtMs: scheduledAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValueOnce({
      status: "error",
      error: "cron: isolated agent setup timed out before runner start",
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
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["timeout"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = requireJob(state, "recurring-setup-timeout-retry");
    expect(jobAfterRetry.enabled).toBe(true);
    expect(jobAfterRetry.state.lastStatus).toBe("error");
    expect(jobAfterRetry.state.lastError).toContain("setup timed out before runner start");
    expect(jobAfterRetry.state.nextRunAtMs).toBeGreaterThan(scheduledAt);
    expect(jobAfterRetry.state.nextRunAtMs).toBeLessThan(scheduledAt + everySixHoursMs);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("uses the normal recurring schedule after transient retry attempts are exhausted", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-29T02:28:00.000Z");
    const everySixHoursMs = 6 * 60 * 60 * 1_000;

    const cronJob = createIsolatedRegressionJob({
      id: "recurring-rate-limit-exhausted",
      name: "Clawsweeper 6h closure report",
      scheduledAt,
      schedule: { kind: "every", everyMs: everySixHoursMs, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "closure report" },
      state: { nextRunAtMs: scheduledAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["rate_limit"] },
      },
    });

    await onTimer(state);
    let job = requireJob(state, "recurring-rate-limit-exhausted");
    expect(job.state.nextRunAtMs).toBeLessThan(scheduledAt + everySixHoursMs);

    now = requireTimestamp(job.state.nextRunAtMs, "recurring exhausted retry") + 1;
    await onTimer(state);

    job = requireJob(state, "recurring-rate-limit-exhausted");
    expect(job.enabled).toBe(true);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.nextRunAtMs).toBe(scheduledAt + everySixHoursMs);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("preserves every cadence after a transient recurring retry succeeds", () => {
    const scheduledAt = Date.parse("2026-05-29T02:28:00.000Z");
    const everyTwelveHoursMs = 12 * 60 * 60 * 1_000;
    const retryStartedAt = scheduledAt + 1_001;

    const cronJob = createIsolatedRegressionJob({
      id: "recurring-rate-limit-edited",
      name: "edited recurring report",
      scheduledAt: retryStartedAt,
      schedule: { kind: "every", everyMs: everyTwelveHoursMs, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "closure report" },
      state: {
        nextRunAtMs: retryStartedAt,
        consecutiveErrors: 1,
      },
    });
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-recurring-rate-limit-edited.json",
      log: noopLogger,
      nowMs: () => retryStartedAt,
      jobs: [cronJob],
    });

    applyJobResult(state, cronJob, {
      status: "ok",
      startedAt: retryStartedAt,
      endedAt: retryStartedAt,
    });

    expect(cronJob.state.lastStatus).toBe("ok");
    expect(cronJob.state.nextRunAtMs).toBe(scheduledAt + everyTwelveHoursMs);
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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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

  it("cancels timeout-disabled cron task runs without waiting for the runner", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();
      resetActiveCronTaskRunsForTests();
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:10:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "no-timeout-cancel",
        name: "no timeout cancel",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      const now = scheduledAt;
      let abortObserved = false;
      let timerSettled = false;
      const runnerStarted = createDeferred<void>();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
          onExecutionStarted?.();
          runnerStarted.resolve();
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

      const timerPromise = onTimer(state).then(() => {
        timerSettled = true;
      });
      await runnerStarted.promise;

      const runId = `cron:no-timeout-cancel:${scheduledAt}`;
      const task = findCronTaskByBaseRunId(runId);
      if (!task) {
        throw new Error("Expected timeout-disabled cron task row");
      }

      installCronCancellationControlRuntime();
      const cancelResult = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });
      expect(cancelResult.found).toBe(true);
      expect(cancelResult.cancelled).toBe(true);
      expect(abortObserved).toBe(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (timerSettled) {
          break;
        }
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(timerSettled).toBe(true);
      await timerPromise;

      const finalTask = listTaskRecords().find((entry) => entry.taskId === task.taskId);
      const job = requireJob(state, "no-timeout-cancel");
      expect(finalTask?.status).toBe("cancelled");
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toBe("Cancelled by operator.");
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
    }
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
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(
      async ({
        abortSignal,
        onExecutionStarted,
        onExecutionPhase,
      }: {
        abortSignal?: AbortSignal;
        onExecutionStarted?: () => void;
        onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
      }) => {
        onExecutionStarted?.();
        onExecutionPhase?.({
          jobId: "agentturn-default-safety-window",
          phase: "attempt_dispatch",
        });
        const result = await deferredRun.promise;
        if (abortSignal?.aborted) {
          return { status: "error" as const, error: String(abortSignal.reason) };
        }
        now += 5;
        return result;
      },
    );
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

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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

  it("unwinds timed cron runs immediately after operator cancellation", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "cancel-before-timeout",
        name: "cancel before timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      const now = scheduledAt;
      const runnerStarted = createDeferred<AbortSignal | undefined>();
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
          onExecutionStarted?.();
          runnerStarted.resolve(abortSignal);
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      const observedAbortSignal = await runnerStarted.promise;
      const runId = `cron:cancel-before-timeout:${scheduledAt}`;
      let timerSettled = false;
      void timerPromise.then(() => {
        timerSettled = true;
      });
      const taskRunId = findCronTaskByBaseRunId(runId)?.runId;
      const cancelled = cancelActiveCronTaskRun({
        runId: taskRunId ?? runId,
        reason: "Cancelled by operator.",
      });

      expect(cancelled).toBe(true);
      expect(observedAbortSignal?.aborted).toBe(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (timerSettled) {
          break;
        }
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(timerSettled).toBe(true);
      await timerPromise;

      expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();
      const job = state.store?.jobs.find((entry) => entry.id === "cancel-before-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toBe("Cancelled by operator.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed-out cron task runs from being overwritten by late cancellation", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();
      resetActiveCronTaskRunsForTests();
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:30:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "late-cancel-after-timeout",
        name: "late cancel after timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      let now = scheduledAt;
      const runnerStarted = createDeferred<void>();
      const cleanupStarted = createDeferred<void>();
      const releaseCleanup = createDeferred<void>();
      const cleanupTimedOutAgentRun = vi.fn(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      });
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        runIsolatedAgentJob: vi.fn(async ({ onExecutionStarted }) => {
          onExecutionStarted?.();
          runnerStarted.resolve();
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      await runnerStarted.promise;
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      now += Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10;
      await cleanupStarted.promise;

      const runId = `cron:late-cancel-after-timeout:${scheduledAt}`;
      const task = findCronTaskByBaseRunId(runId);
      if (!task) {
        throw new Error("Expected timed-out cron task row");
      }
      expect(task.status).toBe("running");

      installCronCancellationControlRuntime();
      const cancelResult = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });
      expect(cancelResult.found).toBe(true);
      expect(cancelResult.cancelled).toBe(false);
      expect(cancelResult.reason).toBe("Cron task has no active cancellation handle.");
      expect(listTaskRecords().find((entry) => entry.taskId === task.taskId)?.status).toBe(
        "running",
      );

      releaseCleanup.resolve();
      await timerPromise;

      const finalTask = listTaskRecords().find((entry) => entry.taskId === task.taskId);
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      expect(finalTask?.status).toBe("timed_out");
      expect(finalTask?.error).toContain("timed out");
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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

  it("keeps resolved provider/model/session on isolated post-runner timeout rows (#95873)", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-attribution",
        name: "timeout attribution",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      const activeJobMarker = markCronJobActive(cronJob.id);

      let now = scheduledAt;
      const runnerEntered = createDeferred<void>();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
          // Report the resolved run identity the same way the real runner does,
          // then hang past the wall-clock watchdog so the timer-built timeout
          // outcome (not the discarded inner result) is what reaches the row.
          onExecutionStarted?.({
            jobId: cronJob.id,
            phase: "tool_execution_started",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            sessionId: "sess-attrib",
            sessionKey: "key-attrib",
          });
          runnerEntered.resolve();
          await new Promise<void>((resolve) => {
            if (!abortSignal || abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          now += 5;
          return { status: "ok" as const, summary: "late" };
        }),
      });

      try {
        const resultPromise = executeJobCoreWithTimeout(state, cronJob, { activeJobMarker });
        await runnerEntered.promise;
        await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
        const result = await resultPromise;

        expect(result.status).toBe("error");
        expect(result.error).toContain("timed out");
        // #95873: a post-runner timeout must not blank out task-run history; the
        // already-resolved attribution carried by the watchdog survives the row.
        expect(result.provider).toBe("deepseek");
        expect(result.model).toBe("deepseek-v4-pro");
        expect(result.sessionId).toBe("sess-attrib");
        expect(result.sessionKey).toBe("key-attrib");
      } finally {
        clearCronJobActive(cronJob.id, activeJobMarker);
      }
    } finally {
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("keeps resolved provider/model/session on timeout-disabled cancel rows (#95873)", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();
      resetActiveCronTaskRunsForTests();
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:20:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "no-timeout-cancel-attribution",
        name: "no timeout cancel attribution",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        // timeoutSeconds: 0 takes the no-watchdog branch, so attribution has to
        // be tracked from the execution callbacks directly (no watchdog snapshot).
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
        state: { nextRunAtMs: scheduledAt },
      });
      const activeJobMarker = markCronJobActive(cronJob.id);

      const now = scheduledAt;
      const runnerEntered = createDeferred<void>();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ onExecutionStarted }) => {
          onExecutionStarted?.({
            jobId: cronJob.id,
            phase: "tool_execution_started",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            sessionId: "sess-attrib",
            sessionKey: "key-attrib",
          });
          runnerEntered.resolve();
          return await new Promise<never>(() => {});
        }),
      });

      const runId = `cron:no-timeout-cancel-attribution:${scheduledAt}`;
      try {
        const resultPromise = executeJobCoreWithTimeout(state, cronJob, {
          runId,
          activeJobMarker,
        });
        await runnerEntered.promise;
        const cancelled = cancelActiveCronTaskRun({
          runId,
          reason: "Cancelled by operator.",
        });
        expect(cancelled).toBe(true);
        const result = await resultPromise;

        expect(result.status).toBe("error");
        expect(result.error).toBe("Cancelled by operator.");
        // #95873 sibling: a timeout-disabled operator-cancel row keeps the
        // already-resolved attribution instead of going blank.
        expect(result.provider).toBe("deepseek");
        expect(result.model).toBe("deepseek-v4-pro");
        expect(result.sessionId).toBe("sess-attrib");
        expect(result.sessionKey).toBe("key-attrib");
      } finally {
        clearCronJobActive(cronJob.id, activeJobMarker);
      }
    } finally {
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryForTests();
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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

  it("persists delivery errors from successful startup catch-up runs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:01:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "startup-delivery-error",
      name: "startup delivery error",
      scheduledAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "work" },
      state: { nextRunAtMs: scheduledAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "work completed",
        delivered: false,
        deliveryError: "Message delivery failed",
      })),
    });

    await runMissedJobs(state);

    const job = requireJob(state, cronJob.id);
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDeliveryStatus).toBe("not-delivered");
    expect(job.state.lastDeliveryError).toBe("Message delivery failed");
  });

  it("notifies setup timeout after startup catch-up finalization", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:02:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "startup-setup-timeout",
        name: "startup setup timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let observedAbortSignal: AbortSignal | undefined;
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          observedAbortSignal = abortSignal;
          started.resolve();
          abortSignal?.addEventListener("abort", () => undefined, { once: true });
          return await new Promise<never>(() => {});
        }),
      });

      const catchupPromise = runMissedJobs(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await catchupPromise;

      expect(observedAbortSignal?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "startup-setup-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("setup timed out before runner start");
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({ id: "startup-setup-timeout" }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps scheduling after setup timeout when no restart handler is installed", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:03:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "setup-timeout-no-handler",
        name: "setup timeout no handler",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          started.resolve();
          abortSignal?.addEventListener("abort", () => undefined, { once: true });
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      expect(state.restartRecoveryPending).toBe(false);
      expect(state.timer).not.toBeNull();
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

  it("keeps user cancellation disabled for main-session cron wrappers", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();

      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob: CronJob = {
        id: "main-session-cancel-boundary",
        name: "main session cancel boundary",
        enabled: true,
        createdAtMs: scheduledAt - 60_000,
        updatedAtMs: scheduledAt - 60_000,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "queued downstream work" },
        state: { nextRunAtMs: scheduledAt },
      };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      let now = scheduledAt;
      const heartbeatResult = createDeferred<HeartbeatRunResult>();
      const runHeartbeatOnce = vi.fn(async (): Promise<HeartbeatRunResult> => {
        return await heartbeatResult.promise;
      });
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        runHeartbeatOnce,
        wakeNowHeartbeatBusyMaxWaitMs: 1_000,
        wakeNowHeartbeatBusyRetryDelayMs: 50,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });

      const timerPromise = onTimer(state);
      const runId = `cron:main-session-cancel-boundary:${scheduledAt}`;
      for (
        let attempt = 0;
        attempt < 10 && runHeartbeatOnce.mock.calls.length === 0;
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);

      const task = findCronTaskByBaseRunId(runId);
      if (!task) {
        throw new Error("Expected main-session cron task row");
      }
      expect(task.status).toBe("running");

      installCronCancellationControlRuntime();
      const cancelResult = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(cancelResult.found).toBe(true);
      expect(cancelResult.cancelled).toBe(false);
      expect(cancelResult.reason).toBe("Cron task has no active cancellation handle.");
      expect(listTaskRecords().find((entry) => entry.taskId === task.taskId)?.status).toBe(
        "running",
      );

      now = scheduledAt + 2_000;
      heartbeatResult.resolve({ status: "skipped", reason: HEARTBEAT_SKIP_LANES_BUSY });
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;

      const expectedSessionKey = `agent:main:cron:main-session-cancel-boundary:run:${scheduledAt}`;
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "queued downstream work",
        expect.objectContaining({
          contextKey: "cron:main-session-cancel-boundary",
          sessionKey: expectedSessionKey,
        }),
      );
      expect(requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "cron:main-session-cancel-boundary",
          sessionKey: expectedSessionKey,
        }),
      );
    } finally {
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("allows cancellation of detached script work targeting the main session", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();
      resetActiveCronTaskRunsForTests();

      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-07-18T12:00:00.000Z");
      const cronJob: CronJob = {
        id: "main-script-cancel-boundary",
        name: "main script cancel boundary",
        enabled: true,
        createdAtMs: scheduledAt - 60_000,
        updatedAtMs: scheduledAt - 60_000,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "script", script: "return { notify: 'done' }", timeoutSeconds: 0 },
        state: { nextRunAtMs: scheduledAt },
      };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      let abortObserved = false;
      let timerSettled = false;
      const runnerStarted = createDeferred<void>();
      const runnerResult = createDeferred<{
        status: "ok";
        notify: string;
        wake: "now";
      }>();
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => scheduledAt,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
        runScriptJob: vi.fn(async ({ abortSignal }) => {
          runnerStarted.resolve();
          abortSignal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
            },
            { once: true },
          );
          // Deliberately ignore abort so the cron boundary must suppress any
          // late notify/wake result after operator cancellation has settled.
          return await runnerResult.promise;
        }),
      });

      const timerPromise = onTimer(state).then(() => {
        timerSettled = true;
      });
      await runnerStarted.promise;

      const task = findCronTaskByBaseRunId(`cron:${cronJob.id}:${scheduledAt}`);
      if (!task) {
        throw new Error("Expected main-target script cron task row");
      }

      installCronCancellationControlRuntime();
      const cancelResult = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });
      expect(cancelResult.found).toBe(true);
      expect(cancelResult.cancelled).toBe(true);
      expect(abortObserved).toBe(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (timerSettled) {
          break;
        }
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(timerSettled).toBe(true);
      await timerPromise;
      expect(listTaskRecords().find((entry) => entry.taskId === task.taskId)?.status).toBe(
        "cancelled",
      );

      runnerResult.resolve({ status: "ok", notify: "stale", wake: "now" });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("keeps main-session cron wrappers visible across restart generation advance", async () => {
    vi.useFakeTimers();
    try {
      resetTaskRegistryForTests();

      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:03:00.000Z");
      const cronJob: CronJob = {
        id: "main-session-generation-visible",
        name: "main session generation visible",
        enabled: true,
        createdAtMs: scheduledAt - 60_000,
        updatedAtMs: scheduledAt - 60_000,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "queued downstream work" },
        state: { nextRunAtMs: scheduledAt },
      };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      let now = scheduledAt;
      const heartbeatResult = createDeferred<HeartbeatRunResult>();
      const runHeartbeatOnce = vi.fn(async (): Promise<HeartbeatRunResult> => {
        return await heartbeatResult.promise;
      });
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat,
        runHeartbeatOnce,
        wakeNowHeartbeatBusyMaxWaitMs: 1_000,
        wakeNowHeartbeatBusyRetryDelayMs: 50,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });

      const timerPromise = onTimer(state);
      for (
        let attempt = 0;
        attempt < 10 && runHeartbeatOnce.mock.calls.length === 0;
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);

      expect(isCronJobActive(cronJob.id)).toBe(true);
      advanceCronActiveJobGeneration();
      expect(isCronJobActive(cronJob.id)).toBe(true);

      now = scheduledAt + 2_000;
      heartbeatResult.resolve({ status: "skipped", reason: HEARTBEAT_SKIP_LANES_BUSY });
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;

      expect(requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "cron:main-session-generation-visible",
        }),
      );
      expect(isCronJobActive(cronJob.id)).toBe(false);
    } finally {
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("retires main-target script work across restart generation advance", async () => {
    resetActiveCronTaskRunsForTests();
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-07-18T12:05:00.000Z");
    const cronJob: CronJob = {
      id: "main-script-generation-retire",
      name: "main script generation retire",
      enabled: true,
      createdAtMs: scheduledAt - 60_000,
      updatedAtMs: scheduledAt - 60_000,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "script", script: "return { notify: 'stale' }", timeoutSeconds: 0 },
      state: { nextRunAtMs: scheduledAt },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const entered = createDeferred<void>();
    const release = createDeferred<{ status: "ok"; notify: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      runScriptJob: vi.fn(async () => {
        entered.resolve();
        return await release.promise;
      }),
    });

    try {
      const timerPromise = onTimer(state);
      await entered.promise;
      expect(isCronJobActive(cronJob.id)).toBe(true);

      advanceCronActiveJobGeneration();
      expect(isCronJobActive(cronJob.id)).toBe(false);
      release.resolve({ status: "ok", notify: "stale" });
      await timerPromise;

      const persisted = await loadCronStore(store.storePath);
      expect(persisted.jobs[0]?.state.lastStatus).not.toBe("ok");
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      resetActiveCronTaskRunsForTests();
    }
  });

  it("rejects cron runner admission after its active marker generation retires", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-13T12:30:00.000Z");
    const cronJob = createDueIsolatedJob({
      id: "retired-generation-admission",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    const activeJobMarker = markCronJobActive(cronJob.id);
    advanceCronActiveJobGeneration();

    const runIsolatedAgentJob = vi.fn(createDefaultIsolatedRunner());
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      const result = await executeJobCoreWithTimeout(state, cronJob, { activeJobMarker });

      expect(result.status).toBe("error");
      expect(result.error).toContain("Gateway restarting");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      clearCronJobActive(cronJob.id, activeJobMarker);
    }
  });

  it("does not persist retired scheduled outcomes after restart generation advance", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-13T12:45:00.000Z");
    const cronJob = createDueIsolatedJob({
      id: "retired-outcome-skip",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const entered = createDeferred<void>();
    const release = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        entered.resolve();
        return await release.promise;
      }),
    });

    const timerPromise = onTimer(state);
    await entered.promise;
    expect(isCronJobActive(cronJob.id)).toBe(true);

    advanceCronActiveJobGeneration();
    release.resolve({ status: "ok", summary: "stale success" });
    await timerPromise;

    const persisted = await loadCronStore(store.storePath);
    const persistedJob = persisted.jobs.find((job) => job.id === cronJob.id);
    expect(persistedJob?.state.lastStatus).not.toBe("ok");
    expect(persistedJob?.state.runningAtMs).toBe(scheduledAt);
  });

  it("releases due-job reservations instead of admitting workers after scheduler stop wins", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-13T13:00:00.000Z");
    const cronJob = createDueIsolatedJob({
      id: "stopped-reservation-release",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    let stopOnNextClockRead = false;
    let stoppedInjected = false;
    const runIsolatedAgentJob = vi.fn(createDefaultIsolatedRunner());
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => {
        if (stopOnNextClockRead && !stoppedInjected) {
          stoppedInjected = true;
          state.stopped = true;
        }
        return scheduledAt;
      },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    stopOnNextClockRead = true;
    await onTimer(state);

    const persisted = await loadCronStore(store.storePath);
    const persistedJob = persisted.jobs.find((job) => job.id === cronJob.id);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(persistedJob?.state.runningAtMs).toBeUndefined();
  });

  it("retries recurring wake-now main jobs until temporary lane pressure clears (#75964)", async () => {
    const store = timerRegressionFixtures.makeStorePath();
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
      state: { nextRunAtMs: 1 },
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
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
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runPromise = runMissedJobs(state);
    await vi.advanceTimersByTimeAsync(1);
    await runPromise;

    const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
      (candidate) => candidate.id === job.id,
    );
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledTimes(2);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.runningAtMs).toBeUndefined();
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
    await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

    let now = dueAt;
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
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
    await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

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

  it("keeps queued scheduled reservations out of stuck-marker cleanup", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.250Z");
    const first = createDueIsolatedJob({
      id: "scheduled-active",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const second = createDueIsolatedJob({
      id: "scheduled-queued",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

    let now = dueAt;
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred<void>();
    const releaseSecond = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        if (job.id === first.id) {
          firstStarted.resolve();
          return await releaseFirst.promise;
        }
        secondStarted.resolve();
        return await releaseSecond.promise;
      }),
    });

    const timerRun = onTimer(state);
    await firstStarted.promise;
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === second.id)?.state.queuedAtMs).toBe(dueAt);
    });
    now += 2 * 60 * 60 * 1000 + 1;
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === second.id)?.state.queuedAtMs).toBe(dueAt);

    releaseFirst.resolve({ status: "ok", summary: "first" });
    await secondStarted.promise;
    const secondStartedAt = now;
    expect(state.store?.jobs.find((job) => job.id === second.id)?.state.runningAtMs).toBe(
      secondStartedAt,
    );
    expect(
      (await loadCronStore(store.storePath))?.jobs.find((job) => job.id === second.id)?.state
        .runningAtMs,
    ).toBe(secondStartedAt);
    expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(true);
    now += 2 * 60 * 60 * 1000 + 1;
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === second.id)?.state.runningAtMs).toBe(
      secondStartedAt,
    );
    now += 100;
    releaseSecond.resolve({ status: "ok", summary: "second" });

    await timerRun;
    const completedSecond = state.store?.jobs.find((job) => job.id === second.id);
    expect(completedSecond?.state.lastRunAtMs).toBe(secondStartedAt);
    expect(completedSecond?.state.lastDurationMs).toBe(2 * 60 * 60 * 1000 + 101);
    expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(false);
  });

  it("shares maxConcurrentRuns with startup catch-up", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.375Z");
    const activeManualJob = createDueIsolatedJob({
      id: "manual-before-startup-catchup",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const catchupJob = createDueIsolatedJob({
      id: "startup-catchup-shared-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeManualJob, catchupJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeManualJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "catch-up" };
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    await activeStarted.promise;
    const catchupRun = runMissedJobs(state);
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === catchupJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    releaseActive.resolve({ status: "ok", summary: "manual" });
    await Promise.all([activeRun, catchupRun]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("rechecks startup catch-up eligibility after an admission wait", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.437Z");
    const activeManualJob = createDueIsolatedJob({
      id: "manual-before-rescheduled-startup-catchup",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const catchupJob = createDueIsolatedJob({
      id: "rescheduled-startup-catchup",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeManualJob, catchupJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeManualJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    await activeStarted.promise;
    const catchupRun = runMissedJobs(state);
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === catchupJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });

    const rescheduledStore = await loadCronStore(store.storePath);
    const rescheduledJob = rescheduledStore.jobs.find((job) => job.id === catchupJob.id);
    if (!rescheduledJob) {
      throw new Error("Expected startup catch-up job");
    }
    rescheduledJob.state.nextRunAtMs = dueAt + 3_600_000;
    await saveCronStore(store.storePath, rescheduledStore);

    releaseActive.resolve({ status: "ok", summary: "manual" });
    await Promise.all([activeRun, catchupRun]);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(
      state.store?.jobs.find((job) => job.id === catchupJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(
      (await loadCronStore(store.storePath)).jobs.find((job) => job.id === catchupJob.id)?.state
        .runningAtMs,
    ).toBeUndefined();
  });

  it("finalizes completed startup catch-up work before a later activation reload failure", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.469Z");
    const first = createDueIsolatedJob({
      id: "failed-startup-catchup-first",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const second = createDueIsolatedJob({
      id: "failed-startup-catchup-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
    let loadCount = 0;
    const loadSpy = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (storePath) => {
        loadCount += 1;
        if (loadCount === 3) {
          throw new Error("startup activation reload failed");
        }
        return await realLoad(storePath);
      });

    try {
      await expect(runMissedJobs(state)).rejects.toThrow("startup activation reload failed");
    } finally {
      loadSpy.mockRestore();
    }

    expect(state.store?.jobs.find((entry) => entry.id === first.id)?.state.lastStatus).toBe("ok");
    expect(
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === first.id)?.state
        .lastStatus,
    ).toBe("ok");
    for (const job of [first, second]) {
      expect(
        state.store?.jobs.find((entry) => entry.id === job.id)?.state.runningAtMs,
      ).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .runningAtMs,
      ).toBeUndefined();
    }
  });

  it("does not start an admitted due job after stop wins its service-lock wait", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.500Z");
    const job = createDueIsolatedJob({
      id: "stopped-due-service-lock",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const releaseServiceLock = createDeferred<void>();
    const serviceLockHeld = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    let currentOperation = state.op;
    let holdNextOperation = true;
    Object.defineProperty(state, "op", {
      configurable: true,
      get: () => currentOperation,
      set: (operation: Promise<unknown>) => {
        if (holdNextOperation) {
          holdNextOperation = false;
          currentOperation = releaseServiceLock.promise;
          serviceLockHeld.resolve();
          return;
        }
        currentOperation = operation;
      },
    });

    const timerRun = onTimer(state);
    await serviceLockHeld.promise;
    stop(state);
    releaseServiceLock.resolve();
    await timerRun;

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("sends one setup-timeout notification when a concurrent cron batch stalls before runners start", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:06:01.000Z");
      const first = createDueIsolatedJob({
        id: "parallel-setup-timeout-first",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const second = createDueIsolatedJob({
        id: "parallel-setup-timeout-second",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      first.payload = { kind: "agentTurn", message: "first", timeoutSeconds: 120 };
      second.payload = { kind: "agentTurn", message: "second", timeoutSeconds: 120 };
      await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

      let now = dueAt;
      let startedCount = 0;
      const bothStarted = createDeferred<void>();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        cronConfig: { maxConcurrentRuns: 2 },
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          startedCount += 1;
          if (startedCount === 2) {
            bothStarted.resolve();
          }
          abortSignal?.addEventListener("abort", () => undefined, { once: true });
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      await bothStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      const jobs = state.store?.jobs ?? [];
      expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("error");
      expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("error");
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({
          id: expect.stringMatching(/^parallel-setup-timeout-/),
        }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies timeout recovery before admitting queued manual work", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:06:31.000Z");
      const first = createDueIsolatedJob({
        id: "serial-timeout-recovery-first",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const second = createDueIsolatedJob({
        id: "serial-timeout-recovery-second",
        nowMs: dueAt,
        nextRunAtMs: dueAt + 3_600_000,
      });
      first.payload = { kind: "agentTurn", message: "first", timeoutSeconds: 120 };
      second.payload = { kind: "agentTurn", message: "second", timeoutSeconds: 120 };
      await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

      let now = dueAt;
      const firstStarted = createDeferred<void>();
      const secondStarted = createDeferred<void>();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        cronConfig: { maxConcurrentRuns: 1 },
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(
          async ({ job, abortSignal }: { job: CronJob; abortSignal?: AbortSignal }) => {
            if (job.id === first.id) {
              firstStarted.resolve();
              abortSignal?.addEventListener("abort", () => undefined, { once: true });
              return await new Promise<never>(() => {});
            }
            expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
            secondStarted.resolve();
            return { status: "ok" as const, summary: "second after recovery" };
          },
        ),
      });

      const timerPromise = onTimer(state);
      await firstStarted.promise;
      const manualRun = runManualCronJob(state, second.id, "force");
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await secondStarted.promise;
      await manualRun;
      await timerPromise;

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
      expect(state.store?.jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("error");
      expect(state.store?.jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends setup-timeout notification after a prior serial cron job completes", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:07:01.000Z");
      const first = createDueIsolatedJob({
        id: "serial-setup-timeout-first",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const second = createDueIsolatedJob({
        id: "serial-setup-timeout-second",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      first.payload = { kind: "agentTurn", message: "first", timeoutSeconds: 120 };
      second.payload = { kind: "agentTurn", message: "second", timeoutSeconds: 120 };
      await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

      let now = dueAt;
      const secondStarted = createDeferred<void>();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        cronConfig: { maxConcurrentRuns: 1 },
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(
          async ({ job, abortSignal }: { job: CronJob; abortSignal?: AbortSignal }) => {
            if (job.id === first.id) {
              now += 10;
              return { status: "ok" as const, summary: "first done" };
            }
            secondStarted.resolve();
            abortSignal?.addEventListener("abort", () => undefined, { once: true });
            return await new Promise<never>(() => {});
          },
        ),
      });

      const timerPromise = onTimer(state);
      await secondStarted.promise;
      expect(isCronJobActive(first.id)).toBe(true);
      expect(isCronJobActive(second.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      const jobs = state.store?.jobs ?? [];
      expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
      expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("error");
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({ id: second.id }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(second.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits to start a scheduled run until a manual run releases the shared limit", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:08:01.000Z");
      const scheduledJob = createDueIsolatedJob({
        id: "mixed-setup-timeout-scheduled",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const manualJob = createDueIsolatedJob({
        id: "mixed-setup-timeout-manual",
        nowMs: dueAt,
        nextRunAtMs: dueAt + 3_600_000,
      });
      scheduledJob.payload = { kind: "agentTurn", message: "scheduled", timeoutSeconds: 120 };
      manualJob.payload = { kind: "agentTurn", message: "manual", timeoutSeconds: 120 };
      await saveCronStore(store.storePath, { version: 1, jobs: [scheduledJob, manualJob] });

      let now = dueAt;
      const manualStarted = createDeferred<void>();
      const scheduledStarted = createDeferred<void>();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        cronConfig: { maxConcurrentRuns: 1 },
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(
          async ({ job, abortSignal }: { job: CronJob; abortSignal?: AbortSignal }) => {
            if (job.id === manualJob.id) {
              manualStarted.resolve();
              abortSignal?.addEventListener("abort", () => undefined, { once: true });
              return await new Promise<never>(() => {});
            }
            scheduledStarted.resolve();
            return { status: "ok" as const, summary: "scheduled after manual" };
          },
        ),
      });

      const manualRun = runManualCronJob(state, manualJob.id, "force");
      await manualStarted.promise;
      const timerRun = onTimer(state);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.runAdmission.active).toBe(1);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await scheduledStarted.promise;
      await timerRun;

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({
          id: expect.stringMatching(/^mixed-setup-timeout-/),
        }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rearms scheduled jobs after manual setup timeout notification", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T08:58:00.000Z");
      const manualJob = createDueIsolatedJob({
        id: "manual-setup-timeout-rearm",
        nowMs: scheduledAt,
        nextRunAtMs: scheduledAt,
      });
      manualJob.payload = { kind: "agentTurn", message: "manual", timeoutSeconds: 120 };
      const scheduledJob = createDueIsolatedJob({
        id: "scheduled-after-manual-setup-timeout",
        nowMs: scheduledAt,
        nextRunAtMs: scheduledAt,
      });
      scheduledJob.payload = { kind: "agentTurn", message: "scheduled", timeoutSeconds: 120 };
      await saveCronStore(store.storePath, { version: 1, jobs: [manualJob, scheduledJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const manualStarted = createDeferred<void>();
      const scheduledStarted = vi.fn();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ job, abortSignal }) => {
          if (job.id === manualJob.id) {
            manualStarted.resolve();
            abortSignal?.addEventListener("abort", () => undefined, { once: true });
            return await new Promise<never>(() => {});
          }
          scheduledStarted(job.id);
          return { status: "ok" as const, summary: "scheduled" };
        }),
      });

      const manualRun = runManualCronJob(state, manualJob.id, "force");
      await manualStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await vi.advanceTimersByTimeAsync(1);

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(state.restartRecoveryPending).toBe(false);
      expect(state.timer).not.toBeNull();
      expect(scheduledStarted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips new manual runs while restart recovery is pending", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-10T08:58:30.000Z");
    const manualJob = createDueIsolatedJob({
      id: "manual-blocked-by-recovery",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [manualJob] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.restartRecoveryPending = true;

    const result = await runManualCronJob(state, manualJob.id, "force");

    expect(result).toEqual({
      ok: true,
      ran: false,
      reason: "restart-recovery-pending",
    });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("does not persist stale startup catch-up outcomes after the old service stops", async () => {
    resetTaskRegistryForTests();
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-10T08:58:45.000Z");
    const job = createDueIsolatedJob({
      id: "stopped-startup-catchup",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    const unstartedJob = createDueIsolatedJob({
      id: "unstarted-stopped-startup-catchup",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    const replacementClaimedJob = createDueIsolatedJob({
      id: "replacement-claimed-stopped-startup-catchup",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [job, unstartedJob, replacementClaimedJob],
    });

    const runStarted = createDeferred<void>();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => {
        runStarted.resolve();
        return await releaseRun.promise;
      },
    });

    const missedJobs = runMissedJobs(state);
    await runStarted.promise;

    state.stopped = true;
    const replacementReservationMs = scheduledAt + 123;
    const replacementStore = await loadCronStore(store.storePath);
    const replacementPersistedJob = replacementStore.jobs.find(
      (entry) => entry.id === replacementClaimedJob.id,
    );
    if (!replacementPersistedJob) {
      throw new Error("expected replacement-claimed startup job");
    }
    replacementPersistedJob.state.queuedAtMs = replacementReservationMs;
    await saveCronStore(store.storePath, replacementStore);

    releaseRun.resolve({ status: "ok", summary: "old service result" });
    await missedJobs;

    const persisted = await loadCronStore(store.storePath);
    const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
    const persistedUnstartedJob = persisted.jobs.find((entry) => entry.id === unstartedJob.id);
    const persistedReplacementClaimedJob = persisted.jobs.find(
      (entry) => entry.id === replacementClaimedJob.id,
    );
    expect(persistedJob?.state.runningAtMs).toBe(scheduledAt);
    expect(persistedJob?.state.lastStatus).toBeUndefined();
    expect(persistedUnstartedJob?.state.runningAtMs).toBeUndefined();
    expect(persistedUnstartedJob?.state.lastStatus).toBeUndefined();
    expect(persistedReplacementClaimedJob?.state.queuedAtMs).toBe(replacementReservationMs);
    expect(persistedReplacementClaimedJob?.state.lastStatus).toBeUndefined();
    expect(
      listTaskRecords().find((entry) => entry.runtime === "cron" && entry.sourceId === job.id)
        ?.status,
    ).toBe("succeeded");
    resetTaskRegistryForTests();
  });

  it("does not clear replacement reservations when stopped timer cleanup releases unclaimed jobs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-10T08:58:50.000Z");
    const runningJob = createDueIsolatedJob({
      id: "stopped-timer-running",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    const replacementClaimedJob = createDueIsolatedJob({
      id: "stopped-timer-replacement-claimed",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [runningJob, replacementClaimedJob],
    });

    const runStarted = createDeferred<void>();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => scheduledAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => {
        runStarted.resolve();
        return await releaseRun.promise;
      },
    });

    const timer = onTimer(state);
    await runStarted.promise;

    state.stopped = true;
    const replacementReservationMs = scheduledAt + 222;
    const replacementStore = await loadCronStore(store.storePath);
    const replacementPersistedJob = replacementStore.jobs.find(
      (entry) => entry.id === replacementClaimedJob.id,
    );
    if (!replacementPersistedJob) {
      throw new Error("expected replacement-claimed timer job");
    }
    replacementPersistedJob.state.queuedAtMs = replacementReservationMs;
    await saveCronStore(store.storePath, replacementStore);

    releaseRun.resolve({ status: "ok", summary: "old service result" });
    await timer;

    const persisted = await loadCronStore(store.storePath);
    expect(
      persisted.jobs.find((entry) => entry.id === replacementClaimedJob.id)?.state.queuedAtMs,
    ).toBe(replacementReservationMs);
  });

  it("starts the scheduled batch after manual setup-timeout notification", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T08:59:00.000Z");
      const manualJob = createDueIsolatedJob({
        id: "manual-setup-timeout-active-batch",
        nowMs: scheduledAt,
        nextRunAtMs: scheduledAt + 3_600_000,
      });
      manualJob.payload = { kind: "agentTurn", message: "manual", timeoutSeconds: 120 };
      const firstScheduledJob = createDueIsolatedJob({
        id: "scheduled-before-manual-recovery",
        nowMs: scheduledAt,
        nextRunAtMs: scheduledAt,
      });
      const secondScheduledJob = createDueIsolatedJob({
        id: "scheduled-blocked-by-manual-recovery",
        nowMs: scheduledAt,
        nextRunAtMs: scheduledAt,
      });
      await saveCronStore(store.storePath, {
        version: 1,
        jobs: [manualJob, firstScheduledJob, secondScheduledJob],
      });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const manualStarted = createDeferred<void>();
      const firstScheduledStarted = createDeferred<void>();
      const finishFirstScheduled = createDeferred<void>();
      const secondScheduledStarted = vi.fn();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        cronConfig: { maxConcurrentRuns: 1 },
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ job, abortSignal, onExecutionStarted }) => {
          if (job.id === manualJob.id) {
            manualStarted.resolve();
            abortSignal?.addEventListener("abort", () => undefined, { once: true });
            return await new Promise<never>(() => {});
          }
          if (job.id === firstScheduledJob.id) {
            firstScheduledStarted.resolve();
            onExecutionStarted?.();
            await finishFirstScheduled.promise;
            return { status: "ok" as const, summary: "first scheduled" };
          }
          secondScheduledStarted(job.id);
          return { status: "ok" as const, summary: "second scheduled" };
        }),
      });

      const manualRun = runManualCronJob(state, manualJob.id, "force");
      await manualStarted.promise;
      const timerRun = onTimer(state);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await firstScheduledStarted.promise;
      expect(state.restartRecoveryPending).toBe(false);

      finishFirstScheduled.resolve();
      await timerRun;

      const second = requireJob(state, secondScheduledJob.id);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(secondScheduledStarted).toHaveBeenCalledWith(secondScheduledJob.id);
      expect(second.state.runningAtMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    await saveCronStore(store.storePath, { version: 1, jobs: [selfRemovingJob] });

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
        const persisted = await loadCronStore(store.storePath);
        await saveCronStore(store.storePath, {
          ...persisted,
          jobs: persisted.jobs.filter((job) => job.id !== params.job.id),
        });
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
    if (!event) {
      throw new Error(`Expected finished event for ${selfRemovingJob.id}`);
    }
    expect(event.action).toBe("finished");
    expect(event.status).toBe("ok");
    expect(event.summary).toBe(`finished ${selfRemovingJob.id}`);
    expect(event.delivered).toBe(true);
    expect(event.deliveryStatus).toBe("delivered");
  });

  it("keeps missing-job discard semantics for failed isolated outcomes", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const failedJob = createDueIsolatedJob({
      id: "self-removing-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [failedJob] });

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
        const persisted = await loadCronStore(store.storePath);
        await saveCronStore(store.storePath, {
          ...persisted,
          jobs: persisted.jobs.filter((job) => job.id !== failedJob.id),
        });
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const wallStart = Date.now();
      let abortWallMs: number | undefined;
      let abortReason: unknown;
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
                abortReason = abortSignal.reason;
                resolve();
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => {
                  abortWallMs = Date.now();
                  abortReason = abortSignal.reason;
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
      expect(abortReason).toMatchObject({
        name: "TimeoutError",
        message: "cron: job execution timed out",
      });

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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        onIsolatedAgentSetupTimeout,
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
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({ id: "isolated-setup-timeout-74803" }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not notify setup timeout for cron-nested lane contention", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T09:01:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "isolated-setup-timeout-lane-wait",
        name: "setup timeout lane wait",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const laneEntered = createDeferred<void>();
      const releaseLane = createDeferred<void>();
      const laneBlocker = enqueueCommandInLane(CommandLane.CronNested, async () => {
        laneEntered.resolve();
        await releaseLane.promise;
      });
      await laneEntered.promise;

      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun: vi.fn(async () => {}),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ onLaneWait }) => {
          onLaneWait?.();
          return await enqueueCommandInLane(CommandLane.CronNested, async () => {
            return { status: "ok" as const, summary: "lane released" };
          });
        }),
      });

      const timerPromise = onTimer(state);
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();
      const job = requireJob(state, cronJob.id);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("setup timed out before runner start");

      releaseLane.resolve();
      await laneBlocker;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not notify setup timeout for custom-session cron waits", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-10T09:04:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "custom-session-setup-timeout",
        name: "custom session setup timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, {
        version: 1,
        jobs: [{ ...cronJob, sessionTarget: "session:customCronSession" }],
      });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun: vi.fn(async () => {}),
        onIsolatedAgentSetupTimeout,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          started.resolve();
          abortSignal?.addEventListener("abort", () => undefined, { once: true });
          return await new Promise<never>(() => {});
        }),
      });

      const timerPromise = onTimer(state);
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      const job = requireJob(state, "custom-session-setup-timeout");
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("setup timed out before runner start");
      expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred<void>();
      let abortObserved = false;
      let abortReason: unknown;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const onIsolatedAgentSetupTimeout = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        onIsolatedAgentSetupTimeout,
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
                abortReason = abortSignal.reason;
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
      expect(abortReason).toMatchObject({
        name: "TimeoutError",
        message: expect.stringContaining("context-engine"),
      });
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      const cleanupArgs = requireRecord(firstMockArg(cleanupTimedOutAgentRun));
      expect(requireRecord(cleanupArgs.job).id).toBe("isolated-pre-model-timeout-74803");
      expect(cleanupArgs.timeoutMs).toBe(1_200_000);
      const execution = requireRecord(cleanupArgs.execution);
      expect(execution.jobId).toBe("isolated-pre-model-timeout-74803");
      expect(execution.phase).toBe("context_engine");
      expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();
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
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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

  it.each([
    {
      phase: "attempt_dispatch",
      phaseText: "attempt-dispatch",
      id: "isolated-attempt-dispatch-81368",
      name: "attempt dispatch regression",
    },
    {
      phase: "context_assembled",
      phaseText: "context-assembled",
      id: "isolated-context-assembled-81368",
      name: "context assembled regression",
    },
    {
      phase: "before_agent_reply",
      phaseText: "before-agent-reply",
      id: "isolated-before-agent-reply-82811",
      name: "before agent reply regression",
    },
  ] satisfies Array<{
    phase: CronAgentExecutionPhase;
    phaseText: string;
    id: string;
    name: string;
  }>)(
    "clears the pre-execution watchdog when isolated cron reaches $phaseText (#81368)",
    async ({ phase, phaseText, id, name }) => {
      vi.useFakeTimers();
      try {
        const store = timerRegressionFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-05-13T09:56:00.000Z");
        const cronJob = createIsolatedRegressionJob({
          id,
          name,
          scheduledAt,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
          payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1_200 },
          state: { nextRunAtMs: scheduledAt },
        });
        await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
                jobId: id,
                phase: "runner_entered",
              });
              onExecutionPhase?.({
                jobId: id,
                phase,
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

        const job = requireJob(state, id);
        expect(abortObserved).toBe(true);
        expect(job.state.lastStatus).toBe("error");
        expect(job.state.lastError).toContain("job execution timed out");
        expect(job.state.lastError).toContain(phaseText);
        expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("re-arms the pre-execution watchdog when before_agent_reply does not claim (#82811)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-05-17T03:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "isolated-before-agent-reply-unhandled-82811",
        name: "before agent reply unhandled regression",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1_200 },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

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
              jobId: "isolated-before-agent-reply-unhandled-82811",
              phase: "runner_entered",
            });
            onExecutionPhase?.({
              jobId: "isolated-before-agent-reply-unhandled-82811",
              phase: "before_agent_reply",
            });
            onExecutionPhase?.({
              jobId: "isolated-before-agent-reply-unhandled-82811",
              phase: "runtime_plugins",
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

      const job = requireJob(state, "isolated-before-agent-reply-unhandled-82811");
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("stalled before execution start");
      expect(job.state.lastError).toContain("runtime-plugins");
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

  it("does not synthesize transient retries when cron schedule computation returns undefined (#66019)", () => {
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
        error: "429 rate limit exceeded",
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

    applyJobResult(state, job, { status: "ok", startedAt, endedAt }, { scheduleMode: "preserve" });

    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.nextRunAtMs).toBe(expectedNextMs);
  });

  it("force run preserves recurring schedule after transient errors", () => {
    const nowMs = Date.now();
    const everyMs = 24 * 60 * 60 * 1_000;
    const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1_000;
    const expectedNextMs = lastScheduledRunMs + everyMs;

    const job: CronJob = {
      id: "daily-job-transient-force",
      name: "Daily job transient force",
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
      storePath: "/tmp/cron-force-run-transient-anchor-test.json",
      log: noopLogger,
      nowMs: () => nowMs,
      jobs: [job],
    });

    const startedAt = nowMs;
    const endedAt = nowMs + 2_000;

    applyJobResult(
      state,
      job,
      { status: "error", error: "429 rate limit exceeded", startedAt, endedAt },
      { scheduleMode: "preserve" },
    );

    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("error");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
