import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { finalizeTaskRunByRunIdCore } from "../../tasks/task-executor.js";
import * as taskRegistry from "../../tasks/task-registry.js";
import { markTaskLostById } from "../../tasks/task-registry.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob } from "../types.js";
import { timeoutErrorMessage } from "./execution-errors.js";
import { createCronServiceState as createCronServiceStateBase } from "./state.js";
import {
  getActiveCronTaskRunId,
  findCronTaskRunRecoveryInDatabase,
  tryCreateCronTaskRun,
  tryFinishCronTaskRun,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";

function createCronServiceState(
  params: Parameters<typeof createCronServiceStateBase>[0],
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({ defaultAgentId: "main", ...params });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
});

describe("cron task run terminal records", () => {
  it.each([
    {
      label: "current",
      id: "current-task-owner",
      agentId: "   ",
      sessionTarget: "current" as const,
      timeoutSeconds: 0,
      initialSessionKey: undefined,
      executionSessionKey: "agent:ops:cron:current-task-owner:run:session-1",
    },
    {
      label: "isolated with creator source",
      id: "isolated-task-owner",
      agentId: "   ",
      sessionTarget: "isolated" as const,
      timeoutSeconds: undefined,
      initialSessionKey: undefined,
      executionSessionKey: "agent:ops:cron:isolated-task-owner:run:session-1",
    },
    {
      label: "custom session target",
      id: "custom-task-owner",
      agentId: "ops",
      sessionTarget: "session:agent:ops:telegram:group:target" as const,
      timeoutSeconds: 0,
      initialSessionKey: undefined,
      executionSessionKey: "agent:ops:telegram:group:target",
    },
  ])("uses the authoritative $label execution transcript", async (testCase) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: `openclaw-cron-${testCase.id}-` },
      async () => {
        resetTaskRegistryForTests();
        let resolveStarted!: () => void;
        let resolveRun!: () => void;
        const started = new Promise<void>((resolve) => {
          resolveStarted = resolve;
        });
        const runPending = new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
        const job: CronJob = {
          id: testCase.id,
          name: testCase.label,
          agentId: testCase.agentId,
          sessionKey: "agent:ops:telegram:group:creator",
          sessionTarget: testCase.sessionTarget,
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: "work",
            ...(testCase.timeoutSeconds !== undefined
              ? { timeoutSeconds: testCase.timeoutSeconds }
              : {}),
          },
          schedule: { kind: "every", everyMs: 60_000 },
          state: {},
          createdAtMs: 100,
          updatedAtMs: 100,
          enabled: true,
        };
        let activeTaskRunId: string | undefined;
        const runIsolatedAgentJob = vi.fn(async ({ onExecutionStarted }) => {
          activeTaskRunId = getActiveCronTaskRunId();
          onExecutionStarted?.({
            jobId: job.id,
            agentId: "ops",
            sessionId: "session-1",
            sessionKey: testCase.executionSessionKey,
            phase: "runner_entered",
          });
          resolveStarted();
          await runPending;
          return {
            status: "ok" as const,
            sessionId: "session-1",
            sessionKey: testCase.executionSessionKey,
          };
        });
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
        });

        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt: 1_500 });
        expect(taskRunId).toBeTruthy();
        const taskRecords = () =>
          listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
            runtime: "cron",
            sourceId: job.id,
          });
        expect(taskRecords()).toHaveLength(1);
        expect(taskRecords()[0]?.agentId).toBe("ops");
        expect(taskRecords()[0]?.childSessionKey).toBe(testCase.initialSessionKey);
        expect(getActiveCronTaskRunId()).toBeUndefined();

        const runPromise = executeJobCoreWithTimeout(state, job, { runId: taskRunId });
        try {
          await started;
          expect(activeTaskRunId).toBe(taskRunId);
          expect(getActiveCronTaskRunId()).toBeUndefined();
          expect(taskRecords()[0]?.agentId).toBe("ops");
          expect(taskRecords()[0]?.childSessionKey).toBe(testCase.executionSessionKey);
          expect(runIsolatedAgentJob.mock.calls[0]?.[0]).not.toHaveProperty("taskRunId");
        } finally {
          resolveRun();
          await runPromise;
        }
      },
    );
  });

  it("persists canonical history directly when a detached runtime is registered", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-core-ledger-runtime-" },
      async () => {
        resetTaskRegistryForTests();
        const customCreate = vi.fn(() => null);
        const customFinalize = vi.fn(() => []);
        setDetachedTaskLifecycleRuntime({
          ...getDetachedTaskLifecycleRuntime(),
          createRunningTaskRun: customCreate,
          finalizeTaskRunByRunId: customFinalize,
        });
        const job: CronJob = {
          id: "core-ledger-runtime",
          name: "core ledger runtime",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "work" },
          state: {},
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => 1_100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        tryFinishCronTaskRun(state, {
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "ok",
            runAtMs: 1_000,
            durationMs: 100,
          },
        });

        expect(customCreate).not.toHaveBeenCalled();
        expect(customFinalize).not.toHaveBeenCalled();
        expect(
          readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(state.deps.storePath),
            jobId: job.id,
          }).entries,
        ).toEqual([expect.objectContaining({ status: "ok", runAtMs: 1_000 })]);
      },
    );
  });

  it("keeps task-registry finalization failures inside the best-effort boundary", () => {
    const warn = vi.fn();
    const startedAt = 500;
    const job: CronJob = {
      id: "lookup-failure",
      name: "lookup failure",
      enabled: true,
      createdAtMs: 100,
      updatedAtMs: 100,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "work" },
      state: {},
    };
    const state = createCronServiceState({
      storePath: "/tmp/jobs.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      nowMs: () => startedAt + 100,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    vi.spyOn(taskRegistry, "findTaskByRunId").mockImplementation(() => {
      throw new Error("task store unavailable");
    });
    expect(() =>
      tryFinishCronTaskRun(state, {
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "ok",
          runAtMs: startedAt,
          durationMs: 100,
        },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(new RegExp(`^cron:${job.id}:${startedAt}:`)),
      }),
      "cron: failed to update task ledger record",
    );
  });

  it("creates an immediately terminal task row for a skipped-only event", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-skipped-task-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 1_000;
        const job: CronJob = {
          id: "skipped-job",
          name: "skipped job",
          agentId: "finn",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        tryFinishCronTaskRun(state, {
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "skipped",
            error: "cron: job execution timed out",
            runId: "manual:skipped-job:1",
            runAtMs: startedAt,
            durationMs: 0,
            nextRunAtMs: 60_000,
          },
        });

        const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          runtime: "cron",
          sourceId: job.id,
          agentId: "finn",
          status: "failed",
          startedAt,
          endedAt: startedAt,
          error: "cron: job execution timed out",
          detail: {
            kind: "cron-run",
            status: "skipped",
            runId: "manual:skipped-job:1",
            nextRunAtMs: 60_000,
          },
        });
        expect(
          readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(state.deps.storePath),
            jobId: job.id,
          }).entries,
        ).toEqual([
          expect.objectContaining({
            jobId: job.id,
            status: "skipped",
            runId: "manual:skipped-job:1",
          }),
        ]);
      },
    );
  });

  it("keeps same-millisecond cron executions as distinct task rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-distinct-task-runs-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 1_500;
        const job: CronJob = {
          id: "same-millisecond-job",
          name: "same millisecond job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const publicRunIds = [
          "manual:same-millisecond-job:1500:1",
          "manual:same-millisecond-job:1500:2",
        ];
        const taskRunIds = publicRunIds.map((publicRunId) =>
          tryCreateCronTaskRun({ state, job, startedAt, publicRunId }),
        );
        expect(new Set(taskRunIds).size).toBe(2);

        for (const [index, taskRunId] of taskRunIds.entries()) {
          if (!taskRunId) {
            throw new Error("expected unique cron task run id");
          }
          tryFinishCronTaskRun(state, {
            taskRunId,
            job,
            event: {
              jobId: job.id,
              action: "finished",
              job,
              status: "ok",
              runId: publicRunIds[index],
              runAtMs: startedAt,
              durationMs: 100,
            },
          });
        }

        const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.runId)).size).toBe(2);
        expect(
          readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(state.deps.storePath),
            jobId: job.id,
          }).entries.map((entry) => entry.runId),
        ).toEqual(expect.arrayContaining(publicRunIds));
      },
    );
  });

  it("keeps operator cancellation while attaching terminal run history", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-cancelled-task-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 2_000;
        const job: CronJob = {
          id: "cancelled-job",
          name: "cancelled job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });
        if (!taskRunId) {
          throw new Error("expected cron task run id");
        }
        finalizeTaskRunByRunIdCore({
          runId: taskRunId,
          runtime: "cron",
          status: "cancelled",
          endedAt: startedAt + 50,
          error: "cancelled by operator",
          terminalSummary: "Cancelled by operator.",
        });

        tryFinishCronTaskRun(state, {
          taskRunId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "ok",
            runAtMs: startedAt,
            durationMs: 100,
          },
        });

        const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(row).toMatchObject({
          status: "cancelled",
          endedAt: startedAt + 100,
          detail: { kind: "cron-run", status: "ok", durationMs: 100 },
        });
        expect(row?.error).toBeUndefined();
        expect(row?.terminalSummary).toBeUndefined();
        expect(
          readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(state.deps.storePath),
            jobId: job.id,
          }).entries,
        ).toEqual([
          expect.objectContaining({
            jobId: job.id,
            status: "ok",
            error: undefined,
          }),
        ]);
      },
    );
  });

  it("retries the original outcome after an empty finalization result", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-retry-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 3_000;
        const job: CronJob = {
          id: "retry-job",
          name: "retry job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });
        if (!taskRunId) {
          throw new Error("expected cron task run id");
        }
        const finalize = taskExecutor.finalizeTaskRunByRunIdCore;
        vi.spyOn(taskExecutor, "finalizeTaskRunByRunIdCore")
          .mockReturnValueOnce([])
          .mockImplementation((params) => finalize(params));

        tryFinishCronTaskRun(state, {
          taskRunId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "ok",
            summary: "done",
            sessionKey: "agent:main:cron:retry-job:run:actual",
            runAtMs: startedAt,
            durationMs: 100,
          },
        });

        const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
          status: "succeeded",
          childSessionKey: "agent:main:cron:retry-job:run:actual",
          terminalSummary: "done",
          detail: { kind: "cron-run", status: "ok" },
        });
      },
    );
  });

  it("overwrites a lost canonical row with restart terminal history", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-lost-recovery-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 4_000;
        const job: CronJob = {
          id: "lost-job",
          name: "lost job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });
        if (!taskRunId) {
          throw new Error("expected cron task run id");
        }
        const [running] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        if (!running) {
          throw new Error("expected running cron task");
        }
        taskRegistry.markTaskTerminalById({
          taskId: running.taskId,
          status: "failed",
          endedAt: startedAt + 40,
          terminalSummary: "Task session disappeared.",
        });
        markTaskLostById({
          taskId: running.taskId,
          endedAt: startedAt + 50,
          error: "backing session missing",
        });
        const renamedJob = { ...job, name: "renamed lost job", sessionTarget: "main" as const };

        tryFinishCronTaskRun(state, {
          taskRunId,
          job: renamedJob,
          event: {
            jobId: job.id,
            action: "finished",
            job: renamedJob,
            status: "error",
            error: "gateway restarted while job was running",
            runAtMs: startedAt,
            durationMs: 100,
          },
        });

        const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
          taskId: running.taskId,
          status: "failed",
          endedAt: startedAt + 100,
          error: "gateway restarted while job was running",
          detail: { kind: "cron-run", status: "error", durationMs: 100 },
        });
        expect(row).not.toHaveProperty("childSessionKey");
        expect(row?.terminalSummary).toBeUndefined();
      },
    );
  });

  it.each([
    "cron: job execution timed out",
    "cron: job execution timed out (last phase: model_call_started)",
    "cron: isolated agent setup timed out before runner start",
    "cron: isolated agent setup timed out before runner start (last phase: preparing)",
    "cron: isolated agent run stalled before execution start",
    "cron: isolated agent run stalled before execution start (last phase: preparing)",
    Object.assign(new Error(), { name: "AbortError" }),
  ])("preserves a provisional timed-out task for case %#", async (input) => {
    const expected = input instanceof Error ? timeoutErrorMessage() : input;
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-provisional-watchdog-timeout-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 5_000;
        const job: CronJob = {
          id: "provisional-watchdog-timeout",
          name: "provisional watchdog timeout",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });
        if (!taskRunId) {
          throw new Error("expected cron task run id");
        }

        tryFinishCronTaskRunWithoutHistory(state, {
          taskRunId,
          status: "error",
          error: input,
          endedAt: startedAt + 100,
        });

        expect(
          listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
            runtime: "cron",
            sourceId: job.id,
          }),
        ).toEqual([
          expect.objectContaining({
            status: "timed_out",
            error: expected,
            endedAt: startedAt + 100,
          }),
        ]);
      },
    );
  });

  it("overwrites a provisional timeout with restart terminal history", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-timeout-recovery-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 5_000;
        const job: CronJob = {
          id: "provisional-timeout-job",
          name: "provisional timeout job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          state: { nextRunAtMs: 60_000 },
        };
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 200,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });
        if (!taskRunId) {
          throw new Error("expected cron task run id");
        }
        tryFinishCronTaskRunWithoutHistory(state, {
          taskRunId,
          status: "error",
          error: timeoutErrorMessage(),
          endedAt: startedAt + 100,
        });

        tryFinishCronTaskRun(state, {
          taskRunId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "error",
            error: "gateway restarted while job was running",
            runAtMs: startedAt,
            durationMs: 200,
          },
        });

        const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(row).toMatchObject({
          status: "failed",
          endedAt: startedAt + 200,
          error: "gateway restarted while job was running",
          detail: { kind: "cron-run", status: "error", durationMs: 200 },
        });
      },
    );
  });

  it("recovers pre-discriminator task rows written by older releases", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-legacy-runid-" },
      async () => {
        resetTaskRegistryForTests();
        const startedAt = 7_000;
        const state = createCronServiceState({
          storePath: "/tmp/jobs.json",
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => startedAt + 100,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const legacyRunId = `cron:legacy-job:${startedAt}`;
        // Older releases persisted the reservation id without a uniqueness suffix.
        taskExecutor.createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "legacy-job",
          ownerKey: "",
          scopeKind: "system",
          runId: legacyRunId,
          task: "legacy job",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          startedAt,
        });
        const recovery = runOpenClawStateWriteTransaction(({ db }) =>
          findCronTaskRunRecoveryInDatabase({
            database: db,
            jobId: "legacy-job",
            startedAt,
            storeKey: cronStoreKey(state.deps.storePath),
          }),
        );
        expect(recovery.taskRunId).toBe(legacyRunId);
        finalizeTaskRunByRunIdCore({
          runId: legacyRunId,
          runtime: "cron",
          status: "timed_out",
          endedAt: startedAt + 50,
          error: timeoutErrorMessage(),
        });

        tryFinishCronTaskRun(state, {
          taskRunId: legacyRunId,
          event: {
            jobId: "legacy-job",
            action: "finished",
            status: "error",
            error: "gateway restarted while job was running",
            runAtMs: startedAt,
            durationMs: 100,
          },
        });

        const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: "legacy-job",
        });
        expect(row).toMatchObject({
          runId: legacyRunId,
          status: "failed",
          error: "gateway restarted while job was running",
          detail: { kind: "cron-run", status: "error", durationMs: 100 },
        });
      },
    );
  });

  it("keeps suffixed recovery identities scoped to the current cron store", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-store-recovery-" },
      async (fixture) => {
        resetTaskRegistryForTests();
        const startedAt = 8_000;
        const job: CronJob = {
          id: "shared-job",
          name: "shared job",
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 100,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "work" },
          state: {},
        };
        const createState = (storePath: string) =>
          createCronServiceState({
            storePath,
            cronEnabled: true,
            log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            nowMs: () => startedAt,
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          });
        const stateA = createState(fixture.path("cron-a", "jobs.json"));
        const stateB = createState(fixture.path("cron-b", "jobs.json"));
        const runA = tryCreateCronTaskRun({ state: stateA, job, startedAt });
        const runB = tryCreateCronTaskRun({ state: stateB, job, startedAt });
        expect(runA).toBeTruthy();
        expect(runB).toBeTruthy();
        expect(runA).not.toBe(runB);

        const findRecoveryId = (state: ReturnType<typeof createCronServiceState>) =>
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              findCronTaskRunRecoveryInDatabase({
                database: db,
                jobId: job.id,
                startedAt,
                storeKey: cronStoreKey(state.deps.storePath),
              }).taskRunId,
          );
        expect(findRecoveryId(stateA)).toBe(runA);
        expect(findRecoveryId(stateB)).toBe(runB);
      },
    );
  });
});
