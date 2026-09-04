// Timer regression tests cover historical cron timer scheduling failures.
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import {
  HEARTBEAT_IDLE_RETRY_GRACE_MS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  HEARTBEAT_SKIP_PREEMPTED,
  type HeartbeatRunResult,
} from "../../infra/heartbeat-wake.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CRON_TASK_KIND } from "../../tasks/cron-task-contract.js";
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
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronAgentExecutionPhaseUpdate, CronJob } from "../types.js";
import {
  cancelActiveCronTaskRun,
  getSuspensionVisibleCronTaskRunCount,
} from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { computeJobNextRunAtMs, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { stop } from "./ops-lifecycle.js";
import { run as runManualCronJob } from "./ops-run.js";
import { createCronServiceState as createBaseCronServiceState, type CronEvent } from "./state.js";
import { executeJobCore } from "./timer-execution.js";
import { applyJobResult, executeJobCoreWithTimeout, runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const FAST_TIMEOUT_SECONDS = 1;
const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

type CronStateParams = Parameters<typeof createBaseCronServiceState>[0] & {
  testAdmissionLimit?: number;
};

function createCronServiceState(params: CronStateParams) {
  const { testAdmissionLimit, ...stateParams } = params;
  const state = createBaseCronServiceState(stateParams);
  if (testAdmissionLimit !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - testAdmissionLimit;
  }
  return state;
}

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
        .mockResolvedValueOnce({ status: "ok", summary: "done", delivered: true });
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

  it("#131491: retains a deleteAfterRun one-shot whose stale guard suppressed its delivery", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");
    const firedAt = scheduledAt + 18 * 60 * 60_000;

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-stale-delivery",
      name: "late report",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "summarize and report" },
      state: { nextRunAtMs: scheduledAt },
    });
    cronJob.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    // Execution succeeded, but the delivery owner rejected its stale output.
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "ok",
      summary: "report finished",
      outputText: "report finished",
      delivered: false,
      deliveryAttempted: true,
      deliveryState: {
        delivered: false,
        status: "not-delivered",
        error: "skipping stale delivery scheduled at 2026-02-06T10:00:00.000Z, started 1080m late",
        failureNotification: { status: "not-requested" },
      },
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => firedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs).toHaveLength(1);
    const job = requireJob({ store: persisted }, cronJob.id);
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDelivered).toBe(false);
    expect(job.state.lastDeliveryStatus).toBe("not-delivered");
    expect(job.state.lastDeliveryError).toContain("skipping stale delivery");

    // A fresh scheduler must retain the evidence without replaying completed work.
    stop(state);
    const restarted = createCronServiceState(state.deps);
    await onTimer(restarted);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect((await loadCronStore(store.storePath)).jobs).toEqual(persisted.jobs);
    stop(restarted);
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
    try {
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
    } finally {
      // Shared hooks clear timers and state; finish this core first.
      stop(state);
      deferredRun.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, deferredRun.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it("cancels timeout-disabled cron task runs without waiting for the runner", async () => {
    vi.useFakeTimers();
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
    const runnerStarted = createDeferred();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
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
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state).then(() => {
      timerSettled = true;
    });
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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
    try {
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
    } finally {
      stop(state);
      deferredRun.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, deferredRun.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
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
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
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
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("keeps timed-out cron task runs from being overwritten by late cancellation", async () => {
    vi.useFakeTimers();
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
    const runnerStarted = createDeferred();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupTimedOutAgentRun = vi.fn(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
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
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
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
      expect(task.taskKind).toBe(CRON_TASK_KIND);

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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      releaseCleanup.resolve();
      await Promise.allSettled([timerPromise, runnerResult.promise, releaseCleanup.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
    }
  });

  it("does not spend isolated execution timeout while waiting for the runner lane (#41783)", async () => {
    vi.useFakeTimers();
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
    const runnerEntered = createDeferred();
    const laneAcquired = createDeferred();
    let observedAbortSignal: AbortSignal | undefined;
    const finishRunner = createDeferred();
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
        if (!abortSignal || abortSignal.aborted) {
          finishRunner.resolve();
        } else {
          abortSignal.addEventListener("abort", () => finishRunner.resolve(), { once: true });
        }
        await finishRunner.promise;
        now += 5;
        return { status: "ok" as const, summary: "late" };
      }),
    });

    const timerPromise = onTimer(state);
    try {
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
      stop(state);
      laneAcquired.resolve();
      finishRunner.resolve();
      await Promise.allSettled([timerPromise, laneAcquired.promise, finishRunner.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("keeps resolved provider/model/session on isolated post-runner timeout rows (#95873)", async () => {
    vi.useFakeTimers();
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
    const runnerEntered = createDeferred();
    const finishRunner = createDeferred();
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
        if (!abortSignal || abortSignal.aborted) {
          finishRunner.resolve();
        } else {
          abortSignal.addEventListener("abort", () => finishRunner.resolve(), { once: true });
        }
        await finishRunner.promise;
        now += 5;
        return { status: "ok" as const, summary: "late" };
      }),
    });

    const resultPromise = executeJobCoreWithTimeout(state, cronJob, { activeJobMarker });
    try {
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
      stop(state);
      finishRunner.resolve();
      await Promise.allSettled([resultPromise, finishRunner.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      clearCronJobActive(cronJob.id, activeJobMarker);
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("keeps resolved provider/model/session on timeout-disabled cancel rows (#95873)", async () => {
    vi.useFakeTimers();
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
    const runnerEntered = createDeferred();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
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
        return await runnerResult.promise;
      }),
    });

    const runId = `cron:no-timeout-cancel-attribution:${scheduledAt}`;
    const resultPromise = executeJobCoreWithTimeout(state, cronJob, {
      runId,
      activeJobMarker,
    });
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([resultPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      clearCronJobActive(cronJob.id, activeJobMarker);
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
    const started = createDeferred();
    let observedAbortSignal: AbortSignal | undefined;
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
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
        return await runnerResult.promise;
      }),
    });

    const catchupPromise = runMissedJobs(state);
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([catchupPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("keeps scheduling after setup timeout without a notification handler", async () => {
    vi.useFakeTimers();
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
    const started = createDeferred();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timerPromise;

      expect(state.timer).not.toBeNull();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("respects abort signals while retrying one-shot main-session wake-now heartbeat runs", async () => {
    const abortController = new AbortController();
    const runHeartbeatOnce = vi.fn(async (): Promise<HeartbeatRunResult> => ({
      status: "skipped",
      reason: "requests-in-flight",
    }));
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

  it.each([
    {
      label: "retries preemption after idle grace",
      staysSkipped: false,
      explicitDeadline: false,
      expectedCalls: 2,
    },
    {
      label: "requeues preemption at the wait budget",
      staysSkipped: true,
      explicitDeadline: false,
      expectedCalls: 3,
    },
    {
      label: "retries busy work at its explicit deadline",
      staysSkipped: false,
      explicitDeadline: true,
      expectedCalls: 2,
    },
    {
      label: "requeues busy work without extending the wait budget",
      staysSkipped: true,
      explicitDeadline: true,
      expectedCalls: 3,
    },
    {
      label: "hands off a deadline beyond the remaining wait budget",
      staysSkipped: true,
      explicitDeadline: true,
      maxWaitMs: 90_000,
      expectedCalls: 2,
    },
    {
      label: "hands off a deadline beyond the entire wait budget",
      staysSkipped: true,
      explicitDeadline: true,
      maxWaitMs: 30_000,
      expectedCalls: 1,
    },
  ])(
    "$label for a wake-now heartbeat",
    async ({ staysSkipped, explicitDeadline, maxWaitMs, expectedCalls }) => {
      vi.useFakeTimers();
      try {
        let heartbeatAttempt = 0;
        const runHeartbeatOnce = vi.fn<() => Promise<HeartbeatRunResult>>(async () =>
          staysSkipped || ++heartbeatAttempt === 1
            ? {
                status: "skipped",
                reason: explicitDeadline
                  ? HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT
                  : HEARTBEAT_SKIP_PREEMPTED,
                ...(explicitDeadline
                  ? { retryAtMs: Date.now() + HEARTBEAT_IDLE_RETRY_GRACE_MS }
                  : {}),
              }
            : { status: "ran", durationMs: 1 },
        );
        const requestHeartbeat = vi.fn();
        const mainJob: CronJob = {
          id: "main-preempted",
          name: "main preempted",
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
          storePath: "/tmp/openclaw-cron-preempted-test/jobs.json",
          log: noopLogger,
          nowMs: () => Date.now(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat,
          runHeartbeatOnce,
          wakeNowHeartbeatBusyMaxWaitMs: maxWaitMs ?? 2 * HEARTBEAT_IDLE_RETRY_GRACE_MS,
          wakeNowHeartbeatBusyRetryDelayMs: 1,
          runIsolatedAgentJob: createDefaultIsolatedRunner(),
        });

        const resultPromise = executeJobCore(state, mainJob);
        await vi.advanceTimersByTimeAsync(1);
        expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_IDLE_RETRY_GRACE_MS - 2);
        expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        if (staysSkipped) {
          await vi.advanceTimersByTimeAsync(HEARTBEAT_IDLE_RETRY_GRACE_MS);
        }
        await expect(resultPromise).resolves.toMatchObject({ status: "ok" });
        expect(runHeartbeatOnce).toHaveBeenCalledTimes(expectedCalls);
        expect(requestHeartbeat).toHaveBeenCalledTimes(staysSkipped ? 1 : 0);
        if (staysSkipped && explicitDeadline) {
          const finalSkip = await runHeartbeatOnce.mock.results.at(-1)?.value;
          expect(requestHeartbeat).toHaveBeenCalledWith(
            expect.objectContaining({ reason: `cron:${mainJob.id}`, intent: "immediate" }),
            finalSkip,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps user cancellation disabled for main-session cron wrappers", async () => {
    vi.useFakeTimers();
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
    try {
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
      heartbeatResult.resolve({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;

      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "queued downstream work",
        expect.objectContaining({
          agentId: "main",
          contextKey: "cron:main-session-cancel-boundary",
        }),
      );
      expect(enqueueSystemEvent.mock.calls[0]?.[1]).not.toHaveProperty("sessionKey");
      expect(requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          reason: "cron:main-session-cancel-boundary",
        }),
        { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT },
      );
      expect(requestHeartbeat.mock.calls[0]?.[0]).not.toHaveProperty("sessionKey");
    } finally {
      stop(state);
      heartbeatResult.resolve({ status: "ran", durationMs: 0 });
      await Promise.allSettled([timerPromise, heartbeatResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("allows cancellation of detached script work targeting the main session", async () => {
    vi.useFakeTimers();
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
    const runnerStarted = createDeferred();
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
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", notify: "stale", wake: "now" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      resetActiveCronTaskRunsForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests();
      vi.useRealTimers();
    }
  });

  it("keeps main-session cron wrappers visible across restart generation advance", async () => {
    vi.useFakeTimers();
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
    try {
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
      heartbeatResult.resolve({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;

      expect(requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "cron:main-session-generation-visible",
        }),
        { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT },
      );
      expect(isCronJobActive(cronJob.id)).toBe(false);
    } finally {
      stop(state);
      heartbeatResult.resolve({ status: "ran", durationMs: 0 });
      await Promise.allSettled([timerPromise, heartbeatResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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

    const entered = createDeferred();
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

    const timerPromise = onTimer(state);
    try {
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
      stop(state);
      release.resolve({ status: "ok", notify: "stale" });
      await Promise.allSettled([timerPromise, release.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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

  it("recovers completed scheduled outcomes after restart generation advance", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-13T12:45:00.000Z");
    const cronJob = createDueIsolatedJob({
      id: "retired-outcome-skip",
      nowMs: scheduledAt,
      nextRunAtMs: scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const entered = createDeferred();
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
    try {
      await entered.promise;
      expect(isCronJobActive(cronJob.id)).toBe(true);

      advanceCronActiveJobGeneration();
      release.resolve({ status: "ok", summary: "stale success" });
      await timerPromise;

      const persisted = await loadCronStore(store.storePath);
      const persistedJob = persisted.jobs.find((job) => job.id === cronJob.id);
      expect(persistedJob?.state.lastStatus).toBe("ok");
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
    } finally {
      stop(state);
      release.resolve({ status: "ok", summary: "stale success" });
      await Promise.allSettled([timerPromise, release.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
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
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
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
      testAdmissionLimit: 1,
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

  it("keeps capacity-blocked scheduled work unreserved until a slot opens", async () => {
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
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
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
    try {
      await firstStarted.promise;
      expect(
        state.store?.jobs.find((job) => job.id === second.id)?.state.queuedAtMs,
      ).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(false);
      now += 2 * 60 * 60 * 1000 + 1;
      recomputeNextRunsForMaintenance(state);
      expect(
        state.store?.jobs.find((job) => job.id === second.id)?.state.queuedAtMs,
      ).toBeUndefined();

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
    } finally {
      stop(state);
      releaseFirst.resolve({ status: "ok", summary: "first" });
      releaseSecond.resolve({ status: "ok", summary: "second" });
      await Promise.allSettled([timerRun, releaseFirst.promise, releaseSecond.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
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

    const activeStarted = createDeferred();
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
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    let catchupRun: ReturnType<typeof runMissedJobs> | undefined;
    try {
      await activeStarted.promise;
      catchupRun = runMissedJobs(state);
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
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(store.storePath), catchupJob.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      stop(state);
      releaseActive.resolve({ status: "ok", summary: "manual" });
      await Promise.allSettled([
        activeRun,
        ...(catchupRun ? [catchupRun] : []),
        releaseActive.promise,
      ]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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

    const releaseServiceLock = createDeferred();
    const serviceLockHeld = createDeferred();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
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
    try {
      await serviceLockHeld.promise;
      stop(state);
      releaseServiceLock.resolve();
      await timerRun;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      stop(state);
      releaseServiceLock.resolve();
      await Promise.allSettled([timerRun, releaseServiceLock.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it("sends one setup-timeout notification when a concurrent cron batch stalls before runners start", async () => {
    vi.useFakeTimers();
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
    const bothStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 2,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async () => {
        startedCount += 1;
        if (startedCount === 2) {
          bothStarted.resolve();
        }
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("does not release a running sibling when setup-timeout recovery clears queued jobs", async () => {
    vi.useFakeTimers();
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:06:21.000Z");
    const stalled = createDueIsolatedJob({
      id: "setup-timeout-stalled",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const running = createDueIsolatedJob({
      id: "setup-timeout-running-sibling",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    stalled.payload = { kind: "agentTurn", message: "stall", timeoutSeconds: 120 };
    running.payload = { kind: "agentTurn", message: "run", timeoutSeconds: 120 };
    await saveCronStore(store.storePath, { version: 1, jobs: [stalled, running] });

    let now = dueAt;
    const runningStarted = createDeferred();
    const finishRunning = createDeferred<{ status: "ok"; summary: string }>();
    const timeoutNotified = createDeferred();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 2,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout: () => timeoutNotified.resolve(),
      runIsolatedAgentJob: vi.fn(
        async ({
          job,
          onExecutionStarted,
        }: Parameters<CronStateParams["runIsolatedAgentJob"]>[0]) => {
          if (job.id === stalled.id) {
            return await runnerResult.promise;
          }
          onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
          runningStarted.resolve();
          return await finishRunning.promise;
        },
      ),
    });

    const timerPromise = onTimer(state);
    try {
      await runningStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timeoutNotified.promise;

      const runningAtMsAfterRecovery = requireJob(state, running.id).state.runningAtMs;
      const reservationHeldAfterRecovery = state.queuedRunReservationsByJobId.has(running.id);
      finishRunning.resolve({ status: "ok", summary: "finished" });
      await timerPromise;

      expect({ runningAtMsAfterRecovery, reservationHeldAfterRecovery }).toEqual({
        runningAtMsAfterRecovery: dueAt,
        reservationHeldAfterRecovery: true,
      });
      expect(requireJob(state, running.id).state.lastStatus).toBe("ok");
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      finishRunning.resolve({ status: "ok", summary: "finished" });
      await Promise.allSettled([timerPromise, runnerResult.promise, finishRunning.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("notifies timeout recovery before admitting queued manual work", async () => {
    vi.useFakeTimers();
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
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id === first.id) {
          firstStarted.resolve();
          return await runnerResult.promise;
        }
        expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
        secondStarted.resolve();
        return { status: "ok" as const, summary: "second after recovery" };
      }),
    });

    const timerPromise = onTimer(state);
    let manualRun: ReturnType<typeof runManualCronJob> | undefined;
    try {
      await firstStarted.promise;
      manualRun = runManualCronJob(state, second.id, "force");
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await secondStarted.promise;
      await manualRun;
      await timerPromise;

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
      expect(state.store?.jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("error");
      expect(state.store?.jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([
        timerPromise,
        ...(manualRun ? [manualRun] : []),
        runnerResult.promise,
      ]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("sends setup-timeout notification after a prior serial cron job completes", async () => {
    vi.useFakeTimers();
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
    const secondStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id === first.id) {
          now += 10;
          return { status: "ok" as const, summary: "first done" };
        }
        secondStarted.resolve();
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
      await secondStarted.promise;
      expect(isCronJobActive(first.id)).toBe(false);
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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([timerPromise, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("waits to start a scheduled run until a manual run releases the shared limit", async () => {
    vi.useFakeTimers();
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
    const manualStarted = createDeferred();
    const scheduledStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id === manualJob.id) {
          manualStarted.resolve();
          return await runnerResult.promise;
        }
        scheduledStarted.resolve();
        return { status: "ok" as const, summary: "scheduled after manual" };
      }),
    });

    const manualRun = runManualCronJob(state, manualJob.id, "force");
    let timerRun: ReturnType<typeof onTimer> | undefined;
    try {
      await manualStarted.promise;
      timerRun = onTimer(state);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);

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
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([manualRun, ...(timerRun ? [timerRun] : []), runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("rearms scheduled jobs after manual setup timeout notification", async () => {
    vi.useFakeTimers();
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
    const manualStarted = createDeferred();
    const scheduledStarted = vi.fn();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }) => {
        if (job.id === manualJob.id) {
          manualStarted.resolve();
          return await runnerResult.promise;
        }
        scheduledStarted(job.id);
        return { status: "ok" as const, summary: "scheduled" };
      }),
    });

    const manualRun = runManualCronJob(state, manualJob.id, "force");
    try {
      await manualStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await vi.advanceTimersByTimeAsync(1);

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(state.timer).not.toBeNull();
      expect(scheduledStarted).not.toHaveBeenCalled();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([manualRun, runnerResult.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("recovers stopped catch-up outcomes without overwriting replacement reservations", async () => {
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

    const runStarted = createDeferred();
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
    try {
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
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastStatus).toBe("ok");
      expect(persistedUnstartedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedUnstartedJob?.state.lastStatus).toBeUndefined();
      expect(persistedReplacementClaimedJob?.state.queuedAtMs).toBe(replacementReservationMs);
      expect(persistedReplacementClaimedJob?.state.lastStatus).toBeUndefined();
      expect(
        listTaskRecords().find((entry) => entry.runtime === "cron" && entry.sourceId === job.id)
          ?.status,
      ).toBe("succeeded");
    } finally {
      stop(state);
      releaseRun.resolve({ status: "ok", summary: "old service result" });
      await Promise.allSettled([missedJobs, releaseRun.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      resetTaskRegistryForTests();
    }
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

    const runStarted = createDeferred();
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
    try {
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
    } finally {
      stop(state);
      releaseRun.resolve({ status: "ok", summary: "old service result" });
      await Promise.allSettled([timer, releaseRun.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it("starts the scheduled batch after manual setup-timeout notification", async () => {
    vi.useFakeTimers();
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
    const manualStarted = createDeferred();
    const firstScheduledStarted = createDeferred();
    const finishFirstScheduled = createDeferred();
    const secondScheduledStarted = vi.fn();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job, onExecutionStarted }) => {
        if (job.id === manualJob.id) {
          manualStarted.resolve();
          return await runnerResult.promise;
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
    let timerRun: ReturnType<typeof onTimer> | undefined;
    try {
      await manualStarted.promise;
      timerRun = onTimer(state);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await firstScheduledStarted.promise;

      finishFirstScheduled.resolve();
      await timerRun;
      await vi.waitFor(() => {
        expect(secondScheduledStarted).toHaveBeenCalledWith(secondScheduledJob.id);
      });

      const second = requireJob(state, secondScheduledJob.id);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(second.state.runningAtMs).toBeUndefined();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      finishFirstScheduled.resolve();
      await Promise.allSettled([
        manualRun,
        ...(timerRun ? [timerRun] : []),
        runnerResult.promise,
        finishFirstScheduled.promise,
      ]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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
      { jobId: selfRemovingJob.id, status: "ok" },
      "cron: finalized run after job was removed during execution",
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

  it.each([
    {
      outcome: "failure",
      status: "error",
      error: "agent failed after removal",
      taskStatus: "failed",
    },
    {
      outcome: "timeout",
      status: "error",
      error: "cron: job execution timed out",
      taskStatus: "timed_out",
    },
    {
      outcome: "skip",
      status: "skipped",
      error: "agent skipped after removal",
      taskStatus: "failed",
    },
  ] as const)(
    "finalizes a removed job's $outcome outcome in operator history",
    async ({ outcome, status, error, taskStatus }) => {
      const store = timerRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
      const failedJob = createDueIsolatedJob({
        id: `self-removing-${outcome}`,
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
          return { status, error };
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
      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: failedJob.id,
          action: "finished",
          status,
          error,
        }),
      );
      const history = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(store.storePath),
        jobId: failedJob.id,
      });
      expect(history.entries).toEqual([
        expect.objectContaining({ jobId: failedJob.id, status, error }),
      ]);
      expect(listTaskRecords().find((task) => task.sourceId === failedJob.id)?.status).toBe(
        taskStatus,
      );
    },
  );

  it.each(["timer maintenance", "startup catch-up"] as const)(
    "persists schedule auto-disable before notifying during %s",
    async (path) => {
      const store = timerRegressionFixtures.makeStorePath();
      const now = Date.parse("2026-08-01T11:00:00.000Z");
      const malformed = createIsolatedRegressionJob({
        id: `malformed-${path}`,
        name: `malformed ${path}`,
        scheduledAt: now,
        schedule: { kind: "cron", expr: "0 1 * * *" },
        payload: { kind: "agentTurn", message: "malformed" },
        state: { scheduleErrorCount: 2 },
      });
      const jobs =
        path === "startup catch-up"
          ? [
              createDueIsolatedJob({ id: "due-startup-catch-up", nowMs: now, nextRunAtMs: now }),
              malformed,
            ]
          : [malformed];
      await saveCronStore(store.storePath, { version: 1, jobs });

      const order: string[] = [];
      const enqueueSystemEvent = vi.fn(() => {
        const persisted = openOpenClawStateDatabase()
          .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(store.storePath), malformed.id) as { enabled: number };
        expect(persisted.enabled).toBe(0);
        order.push("notify");
      });
      const requestHeartbeat = vi.fn(() => {
        expect(order.at(-1)).toBe("notify");
        order.push("heartbeat");
      });
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });
      const computeNextRunAtMs = schedule.computeNextRunAtMs;
      vi.spyOn(schedule, "computeNextRunAtMs").mockImplementation((cronSchedule, nowMs) => {
        if (cronSchedule.kind === "cron" && cronSchedule.expr === "0 1 * * *") {
          throw new Error("simulated schedule failure");
        }
        return computeNextRunAtMs(cronSchedule, nowMs);
      });
      if (path === "startup catch-up") {
        await runMissedJobs(state);
      } else {
        await onTimer(state);
      }

      expect(order).toEqual(["notify", "heartbeat"]);
      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((job) => job.id === malformed.id),
      ).toMatchObject({ enabled: false });
    },
  );

  it("auto-disables a recurring job on its tenth consecutive run failure", () => {
    const startedAt = Date.parse("2026-08-01T12:00:00.000Z");
    const deferredNotifications: Array<() => void> = [];
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-consecutive-failure-threshold.json",
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "recurring-failure-threshold",
      name: "recurring failure threshold",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "fail" },
      state: { consecutiveErrors: 8 },
    });
    job.failureAlert = { after: 10, cooldownMs: 0 };

    applyJobResult(
      state,
      job,
      { status: "error", error: "ninth failure", startedAt, endedAt: startedAt + 10 },
      { deferredNotifications },
    );
    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(9);
    expect(job.state.autoDisabled).toBeUndefined();
    expect(deferredNotifications).toHaveLength(0);

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "tenth failure",
        startedAt: startedAt + 60_000,
        endedAt: startedAt + 60_010,
      },
      { deferredNotifications },
    );
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.autoDisabled).toEqual({
      reason: "consecutive-failures",
      atMs: startedAt + 60_010,
      consecutiveErrors: 10,
    });
    expect(deferredNotifications).toHaveLength(1);
    deferredNotifications[0]?.();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("resets the auto-disable streak after a successful recurring run", () => {
    const startedAt = Date.parse("2026-08-01T13:00:00.000Z");
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-consecutive-failure-reset.json",
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "recurring-failure-reset",
      name: "recurring failure reset",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "recover" },
      state: {},
    });
    const apply = (status: "ok" | "error", run: number) =>
      applyJobResult(
        state,
        job,
        {
          status,
          ...(status === "error" ? { error: `failure ${run}` } : {}),
          startedAt: startedAt + run * 60_000,
          endedAt: startedAt + run * 60_000 + 10,
        },
        { deferredNotifications: [] },
      );

    for (let run = 0; run < 9; run += 1) {
      apply("error", run);
    }
    apply("ok", 9);
    for (let run = 10; run < 19; run += 1) {
      apply("error", run);
    }

    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(9);
    expect(job.state.autoDisabled).toBeUndefined();
  });

  it.each([
    { name: "stale schedule", opts: { scheduleOwnership: "stale" as const } },
    { name: "forced run", opts: { scheduleMode: "preserve" as const } },
  ])("does not auto-disable but still alerts after a $name failure", ({ opts }) => {
    const startedAt = Date.parse("2026-08-01T14:00:00.000Z");
    const deferredNotifications: Array<() => void> = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-non-owning-failure.json",
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "non-owning-recurring-failure",
      name: "non-owning recurring failure",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "fail" },
      state: { consecutiveErrors: 9, nextRunAtMs: startedAt + 60_000 },
    });

    applyJobResult(
      state,
      job,
      { status: "error", error: "tenth failure", startedAt, endedAt: startedAt + 10 },
      { ...opts, deferredNotifications },
    );

    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(10);
    expect(job.state.autoDisabled).toBeUndefined();
    expect(deferredNotifications).toHaveLength(1);
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

  it("does not retry permanent script failures with timeout-looking text", () => {
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    const endedAt = startedAt + 500;
    const job = createIsolatedRegressionJob({
      id: "permanent-script-failure",
      name: "permanent-script-failure",
      scheduledAt: startedAt,
      schedule: { kind: "at", at: new Date(startedAt).toISOString() },
      payload: { kind: "script", script: "throw new Error('request timed out')" },
      state: { runningAtMs: startedAt },
    });
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-permanent-script-failure.json",
      log: noopLogger,
      nowMs: () => endedAt,
      jobs: [job],
    });

    applyJobResult(state, job, {
      status: "error",
      error: "cron script failed after a tool side effect: request timed out",
      errorClassification: { kind: "permanent" },
      executionStarted: true,
      startedAt,
      endedAt,
    });

    expect(job.state.lastErrorReason).toBeUndefined();
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.enabled).toBe(false);
  });

  it("retries explicitly classified script timeouts", () => {
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    const endedAt = startedAt + 500;
    const job = createIsolatedRegressionJob({
      id: "transient-script-timeout",
      name: "transient-script-timeout",
      scheduledAt: startedAt,
      schedule: { kind: "at", at: new Date(startedAt).toISOString() },
      payload: { kind: "script", script: "while (true) {}" },
      state: { runningAtMs: startedAt },
    });
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-transient-script-timeout.json",
      log: noopLogger,
      nowMs: () => endedAt,
      jobs: [job],
    });

    applyJobResult(state, job, {
      status: "error",
      error: "cron script payload failed (timeout): wall-clock timeout exceeded",
      errorClassification: { kind: "reason", reason: "timeout" },
      executionStarted: true,
      startedAt,
      endedAt,
    });

    expect(job.state.lastErrorReason).toBe("timeout");
    expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
    expect(job.enabled).toBe(true);
  });

  it("classifies interrupted agent transport before applying bounded retry", () => {
    const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
    const endedAt = startedAt + 500;
    const job = createIsolatedRegressionJob({
      id: "transient-agent-transport",
      name: "transient-agent-transport",
      scheduledAt: startedAt,
      schedule: { kind: "at", at: new Date(startedAt).toISOString() },
      payload: { kind: "agentTurn", message: "ping" },
      state: { runningAtMs: startedAt },
    });
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-transient-agent-transport.json",
      log: noopLogger,
      nowMs: () => endedAt,
      jobs: [job],
    });

    applyJobResult(state, job, {
      status: "error",
      error: "stream disconnected before completion: upstream reset",
      executionStarted: true,
      startedAt,
      endedAt,
    });

    expect(job.state.lastErrorReason).toBe("timeout");
    expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
    expect(job.enabled).toBe(true);
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
