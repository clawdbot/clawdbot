// Integration regressions for cron execution timeouts and setup watchdogs.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { saveCronStore } from "../store.js";
import type {
  CronAgentExecutionPhase,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { onTimer } from "./timer.test-support.js";

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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function firstMockArg(mock: unknown): unknown {
  const calls = (mock as { mock: { calls: readonly (readonly unknown[])[] } }).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

describe("cron service timer regressions", () => {
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
      const started = createDeferred();

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
      const started = createDeferred();
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
      const started = createDeferred();
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

  it("does not spend setup timeout while waiting for cron-nested admission", async () => {
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
      const laneEntered = createDeferred();
      const releaseLane = createDeferred();
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
          onLaneWait?.({ waiting: true });
          return await enqueueCommandInLane(CommandLane.CronNested, async () => {
            onLaneWait?.({ waiting: false });
            return { status: "ok" as const, summary: "lane released" };
          });
        }),
      });

      const timerPromise = onTimer(state);
      let timerSettled = false;
      void timerPromise.then(() => {
        timerSettled = true;
      });
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;

      expect(timerSettled).toBe(false);
      expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();

      releaseLane.resolve();
      await laneBlocker;
      await timerPromise;

      const job = requireJob(state, cronJob.id);
      expect(job.state.lastStatus).toBe("ok");
      expect(job.state.lastError).toBeUndefined();
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
      const started = createDeferred();
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

  it("lets isolated setup progress use the configured job timeout (#93912)", async () => {
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
      const started = createDeferred();
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
            for (const phase of [
              "workspace",
              "runtime_plugins",
              "before_agent_reply",
              "runtime_plugins",
              "model_resolution",
              "auth",
              "context_engine",
            ] as const) {
              onExecutionPhase?.({
                jobId: "isolated-pre-model-timeout-74803",
                agentId: "main",
                sessionId: "cron-run-session",
                sessionKey: "agent:main:cron:isolated-pre-model-timeout-74803:run:cron-run-session",
                phase,
              });
            }
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
      expect(abortObserved).toBe(false);
      expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_139_900);
      now += 1_139_900;
      await timerPromise;

      const job = requireJob(state, "isolated-pre-model-timeout-74803");
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toContain("job execution timed out");
      expect(job.state.lastError).toContain("context-engine");
      expect(abortReason).toMatchObject({
        name: "TimeoutError",
        message: expect.stringContaining("job execution timed out"),
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
      const started = createDeferred();
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
        const started = createDeferred();
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

  it("re-arms the pre-execution watchdog when a fallback runner returns to setup (#82811)", async () => {
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
      cronJob.delivery = {
        mode: "announce",
        channel: "telegram",
        to: "19098680",
        bestEffort: true,
      };
      cronJob.failureAlert = {
        after: 1,
        mode: "announce",
        channel: "telegram",
        to: "12345",
      };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const started = createDeferred();
      let abortObserved = false;
      const cleanupTimedOutAgentRun = vi.fn(async () => {});
      const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
        async () => {},
      );
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        cleanupTimedOutAgentRun,
        sendCronFailureAlert,
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
            onExecutionStarted?.({
              jobId: "isolated-before-agent-reply-unhandled-82811",
              phase: "runner_entered",
              isFallback: true,
              provider: "fallback-provider",
              model: "fallback-model",
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
      const diagnostic =
        "cron: isolated agent run stalled before execution start (last phase: runtime-plugins)";
      expect(abortObserved).toBe(true);
      expect(job.state.lastStatus).toBe("error");
      expect(job.state.lastError).toBe(diagnostic);
      expect(job.state.lastDiagnosticSummary).toBe(diagnostic);
      expect(job.state.lastDiagnostics).toEqual({
        summary: diagnostic,
        entries: [
          { source: "cron-setup", severity: "error", message: diagnostic, ts: scheduledAt },
        ],
      });
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledTimes(1);
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
      expect(sendCronFailureAlert).toHaveBeenCalledExactlyOnceWith({
        job: expect.objectContaining({
          id: "isolated-before-agent-reply-unhandled-82811",
          state: expect.objectContaining({ lastDiagnosticSummary: diagnostic }),
        }),
        payload: {
          text:
            'Automation "before agent reply unhandled regression" failed 1 times\n' +
            "Check automation history for details.",
        },
        runAtMs: expect.any(Number),
        channel: "telegram",
        to: "12345",
        mode: "announce",
        accountId: undefined,
        threadId: undefined,
        inheritSessionThread: false,
        onDeliveryAttempt: expect.any(Function),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
