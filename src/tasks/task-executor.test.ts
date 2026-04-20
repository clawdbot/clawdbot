import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  getDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime.js";
import {
  cancelFlowById,
  cancelFlowByIdForOwner,
  cancelDetachedTaskRunById,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  retryBlockedFlowAsQueuedTaskRun,
  runTaskInFlow,
  runTaskInFlowForOwner,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  setTaskRegistryDeliveryRuntimeForTests,
  getTaskById,
  findLatestTaskForFlowId,
  findTaskByRunId,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

async function withTaskExecutorStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-task-executor-", async ({ stateDir }) => {
    resetDetachedTaskLifecycleRuntimeForTests();
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryControlRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    setTaskRegistryControlRuntimeForTests({
      getAcpSessionManager: () => ({
        cancelSession: hoisted.cancelSessionMock,
      }),
      killSubagentRunAdmin: async (params) => hoisted.killSubagentRunAdminMock(params),
    });
    try {
      await run(stateDir);
    } finally {
      resetSystemEventsForTest();
      resetHeartbeatWakeStateForTests();
      resetAgentEventsForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetAgentRunContextForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("task-executor", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryControlRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("advances a queued run through start and completion", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createQueuedTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-executor-queued",
        task: "Investigate issue",
      });

      expect(created.status).toBe("queued");

      startTaskRunByRunId({
        runId: "run-executor-queued",
        startedAt: 100,
        lastEventAt: 100,
        eventSummary: "Started.",
      });

      completeTaskRunByRunId({
        runId: "run-executor-queued",
        endedAt: 250,
        lastEventAt: 250,
        terminalSummary: "Done.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        startedAt: 100,
        endedAt: 250,
        terminalSummary: "Done.",
      });
    });
  });

  it("records progress, failure, and delivery status through the executor", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-fail",
        task: "Write summary",
        startedAt: 10,
      });

      recordTaskRunProgressByRunId({
        runId: "run-executor-fail",
        lastEventAt: 20,
        progressSummary: "Collecting results",
        eventSummary: "Collecting results",
      });

      failTaskRunByRunId({
        runId: "run-executor-fail",
        endedAt: 40,
        lastEventAt: 40,
        error: "tool failed",
      });

      setDetachedTaskDeliveryStatusByRunId({
        runId: "run-executor-fail",
        deliveryStatus: "failed",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "failed",
        progressSummary: "Collecting results",
        error: "tool failed",
        deliveryStatus: "failed",
      });
    });
  });

  it("persists explicit task kind metadata on created runs", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "cli",
        taskKind: "video_generation",
        sourceId: "video_generate:openai",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-executor-kind",
        task: "Generate lobster video",
        startedAt: 10,
        deliveryStatus: "not_applicable",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        taskKind: "video_generation",
        sourceId: "video_generate:openai",
      });
      expect(findTaskByRunId("run-executor-kind")).toMatchObject({
        taskId: created.taskId,
        taskKind: "video_generation",
      });
    });
  });

  it("auto-creates a one-task flow and keeps it synced with task status", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-flow",
        task: "Write summary",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      expect(created.parentFlowId).toEqual(expect.any(String));
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        ownerKey: "agent:main:main",
        status: "running",
        goal: "Write summary",
        notifyPolicy: "done_only",
      });

      completeTaskRunByRunId({
        runId: "run-executor-flow",
        endedAt: 40,
        lastEventAt: 40,
        terminalSummary: "Done.",
      });

      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "succeeded",
        endedAt: 40,
        goal: "Write summary",
        notifyPolicy: "done_only",
      });
    });
  });

  it("does not auto-create one-task flows for non-returning bookkeeping runs", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-executor-cli",
        task: "Foreground gateway run",
        deliveryStatus: "not_applicable",
        startedAt: 10,
      });

      expect(created.parentFlowId).toBeUndefined();
      expect(listTaskFlowRecords()).toEqual([]);
    });
  });

  it("records blocked metadata on one-task flows and reuses the same flow for queued retries", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-executor-blocked",
        task: "Patch file",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      completeTaskRunByRunId({
        runId: "run-executor-blocked",
        endedAt: 40,
        lastEventAt: 40,
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "blocked",
        blockedTaskId: created.taskId,
        blockedSummary: "Writable session required.",
        endedAt: 40,
      });

      const retried = retryBlockedFlowAsQueuedTaskRun({
        flowId: created.parentFlowId!,
        runId: "run-executor-retry",
        childSessionKey: "agent:codex:acp:retry-child",
      });

      expect(retried).toMatchObject({
        found: true,
        retried: true,
        previousTask: expect.objectContaining({
          taskId: created.taskId,
        }),
        task: expect.objectContaining({
          parentFlowId: created.parentFlowId,
          parentTaskId: created.taskId,
          status: "queued",
          runId: "run-executor-retry",
        }),
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "queued",
      });
      expect(findLatestTaskForFlowId(created.parentFlowId!)).toMatchObject({
        runId: "run-executor-retry",
      });
      expect(findTaskByRunId("run-executor-blocked")).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
    });
  });

  it("cancels active tasks linked to a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });
      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-linear-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(findTaskByRunId("run-linear-cancel")).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
      });
    });
  });

  it("runs child tasks under managed TaskFlows", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });

      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-child",
        label: "Inspect a PR",
        task: "Inspect a PR",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      });

      expect(created).toMatchObject({
        found: true,
        created: true,
        task: expect.objectContaining({
          parentFlowId: flow.flowId,
          ownerKey: "agent:main:main",
          status: "running",
          runId: "run-flow-child",
        }),
      });
      expect(getTaskById(created.task!.taskId)).toMatchObject({
        parentFlowId: flow.flowId,
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
      });
    });
  });

  it("refuses to add child tasks once cancellation is requested on a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });

      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-after-cancel",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        found: true,
        created: false,
        reason: "Flow cancellation has already been requested.",
      });
    });
  });

  it("sets cancel intent before child tasks settle and finalizes later", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockRejectedValue(new Error("still shutting down"));

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Long running batch",
      });
      const child = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-sticky-cancel",
        task: "Inspect a PR",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      }).task!;

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: "One or more child tasks are still active.",
        flow: expect.objectContaining({
          flowId: flow.flowId,
          cancelRequestedAt: expect.any(Number),
          status: "queued",
        }),
      });

      failTaskRunByRunId({
        runId: "run-flow-sticky-cancel",
        endedAt: 50,
        lastEventAt: 50,
        error: "cancel completed later",
        status: "cancelled",
      });

      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        cancelRequestedAt: expect.any(Number),
        status: "cancelled",
        endedAt: 50,
      });
    });
  });

  it("denies cross-owner flow cancellation through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const cancelled = await cancelFlowByIdForOwner({
        cfg: {} as never,
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
      });

      expect(cancelled).toMatchObject({
        found: false,
        cancelled: false,
        reason: "Flow not found.",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "queued",
      });
    });
  });

  it("denies cross-owner managed TaskFlow child spawning through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const created = runTaskInFlowForOwner({
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-cross-owner",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        found: false,
        created: false,
        reason: "Flow not found.",
      });
      expect(findLatestTaskForFlowId(flow.flowId)).toBeUndefined();
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-linear-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:acp:child",
        reason: "task-cancel",
      });
    });
  });

  it("dispatches detached task cancellation through the registered runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-external-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const cancelDetachedTaskRunByIdSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.cancelDetachedTaskRunById>) =>
          defaultRuntime.cancelDetachedTaskRunById(...args),
      );

      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: child.taskId,
      });
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
    });
  });

  it("falls back to the legacy canceller when the registered runtime declines task ownership", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-runtime-decline-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelDetachedTaskRunByIdSpy = vi.fn(async () => ({
        found: false,
        cancelled: false,
        reason: "not owned by runtime",
      }));

      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: child.taskId,
      });
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:acp:child",
        reason: "task-cancel",
      });
    });
  });

  it("does not fall back when the registered runtime claims task ownership", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-runtime-owned-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelDetachedTaskRunByIdSpy = vi.fn(async () => ({
        found: true,
        cancelled: false,
        reason: "runtime refused cancel",
      }));

      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: "runtime refused cancel",
      });
      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: child.taskId,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "running",
      });
      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
    });
  });

  it("cancels active subagent child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-subagent-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:subagent:child",
      });
    });
  });

  it("routes TaskFlow cancellation through the registered detached runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/cancel-flow",
        goal: "Cancel linked tasks",
      });
      const child = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-cancel-via-runtime",
        task: "Cancel flow child",
        status: "running",
        startedAt: 10,
      });
      if (!child.created) {
        throw new Error("expected child task creation to succeed");
      }
      const childTask = child.task;
      if (!childTask) {
        throw new Error("expected child task payload");
      }

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const cancelDetachedTaskRunByIdSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.cancelDetachedTaskRunById>) =>
          defaultRuntime.cancelDetachedTaskRunById(...args),
      );
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: childTask.taskId,
      });
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
        flow: {
          flowId: flow.flowId,
          status: "cancelled",
        },
      });
    });
  });

  it("scopes run-id updates to the matching runtime and session", async () => {
    await withTaskExecutorStateDir(async () => {
      const victim = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:victim:main",
        scopeKind: "session",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-shared-executor-scope",
        task: "Victim ACP task",
        deliveryStatus: "pending",
      });
      const attacker = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:attacker:main",
        scopeKind: "session",
        childSessionKey: "agent:attacker:main",
        runId: "run-shared-executor-scope",
        task: "Attacker CLI task",
        deliveryStatus: "not_applicable",
      });

      failTaskRunByRunId({
        runId: "run-shared-executor-scope",
        runtime: "cli",
        sessionKey: "agent:attacker:main",
        endedAt: 40,
        lastEventAt: 40,
        error: "attacker controlled error",
      });

      expect(getTaskById(attacker.taskId)).toMatchObject({
        status: "failed",
        error: "attacker controlled error",
      });
      expect(getTaskById(victim.taskId)).toMatchObject({
        status: "running",
      });
    });
  });
});
