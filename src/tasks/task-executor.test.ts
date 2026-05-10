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

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
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

function expectParentFlowId(task: { parentFlowId?: string }): string {
  expect(task.parentFlowId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  if (task.parentFlowId === undefined) {
    throw new Error("Expected task parent flow id");
  }
  return task.parentFlowId;
}

function requireCreatedFlowTask(
  result: ReturnType<typeof runTaskInFlow>,
): NonNullable<ReturnType<typeof runTaskInFlow>["task"]> {
  if (!result.task) {
    throw new Error("Expected TaskFlow child task to be created");
  }
  return result.task;
}

function expectCancelRequestedAt(value: unknown): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error("Expected numeric cancelRequestedAt");
  }
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
  return value;
}

function createRunningAcpChildTaskRun(
  overrides: Partial<Parameters<typeof createRunningTaskRun>[0]> = {},
) {
  return createRunningTaskRun({
    runtime: "acp",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:child",
    runId: "run-acp-child",
    task: "Inspect a PR",
    startedAt: 10,
    deliveryStatus: "pending",
    ...overrides,
  });
}

function spyOnRuntimeCancel() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const cancelDetachedTaskRunByIdSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.cancelDetachedTaskRunById>) =>
      defaultRuntime.cancelDetachedTaskRunById(...args),
  );

  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
  });

  return cancelDetachedTaskRunByIdSpy;
}

function expectCancelledAcpChildTask(
  child: ReturnType<typeof createRunningTaskRun>,
  cancelled: { found?: boolean; cancelled?: boolean },
) {
  expect(cancelled.found).toBe(true);
  expect(cancelled.cancelled).toBe(true);
  const task = getTaskById(child.taskId);
  expect(task?.taskId).toBe(child.taskId);
  expect(task?.status).toBe("cancelled");
  expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
    cfg: {} as never,
    sessionKey: "agent:codex:acp:child",
    reason: "task-cancel",
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

      const task = getTaskById(created.taskId);
      expect(task?.taskId).toBe(created.taskId);
      expect(task?.status).toBe("succeeded");
      expect(task?.startedAt).toBe(100);
      expect(task?.endedAt).toBe(250);
      expect(task?.terminalSummary).toBe("Done.");
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

      const task = getTaskById(created.taskId);
      expect(task?.taskId).toBe(created.taskId);
      expect(task?.status).toBe("failed");
      expect(task?.progressSummary).toBe("Collecting results");
      expect(task?.error).toBe("tool failed");
      expect(task?.deliveryStatus).toBe("failed");
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

      const task = getTaskById(created.taskId);
      expect(task?.taskId).toBe(created.taskId);
      expect(task?.taskKind).toBe("video_generation");
      expect(task?.sourceId).toBe("video_generate:openai");
      const found = findTaskByRunId("run-executor-kind");
      expect(found?.taskId).toBe(created.taskId);
      expect(found?.taskKind).toBe("video_generation");
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

      const parentFlowId = expectParentFlowId(created);
      const runningFlow = getTaskFlowById(parentFlowId);
      expect(runningFlow?.flowId).toBe(parentFlowId);
      expect(runningFlow?.ownerKey).toBe("agent:main:main");
      expect(runningFlow?.status).toBe("running");
      expect(runningFlow?.goal).toBe("Write summary");
      expect(runningFlow?.notifyPolicy).toBe("done_only");

      completeTaskRunByRunId({
        runId: "run-executor-flow",
        endedAt: 40,
        lastEventAt: 40,
        terminalSummary: "Done.",
      });

      const succeededFlow = getTaskFlowById(parentFlowId);
      expect(succeededFlow?.flowId).toBe(parentFlowId);
      expect(succeededFlow?.status).toBe("succeeded");
      expect(succeededFlow?.endedAt).toBe(40);
      expect(succeededFlow?.goal).toBe("Write summary");
      expect(succeededFlow?.notifyPolicy).toBe("done_only");
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
      expect(listTaskFlowRecords()).toStrictEqual([]);
    });
  });

  it("records blocked metadata on one-task flows and reuses the same flow for queued retries", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
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

      const blockedTask = getTaskById(created.taskId);
      expect(blockedTask?.taskId).toBe(created.taskId);
      expect(blockedTask?.status).toBe("succeeded");
      expect(blockedTask?.terminalOutcome).toBe("blocked");
      expect(blockedTask?.terminalSummary).toBe("Writable session required.");
      const parentFlowId = expectParentFlowId(created);
      const blockedFlow = getTaskFlowById(parentFlowId);
      expect(blockedFlow?.flowId).toBe(parentFlowId);
      expect(blockedFlow?.status).toBe("blocked");
      expect(blockedFlow?.blockedTaskId).toBe(created.taskId);
      expect(blockedFlow?.blockedSummary).toBe("Writable session required.");
      expect(blockedFlow?.endedAt).toBe(40);

      const retried = retryBlockedFlowAsQueuedTaskRun({
        flowId: parentFlowId,
        runId: "run-executor-retry",
        childSessionKey: "agent:codex:acp:retry-child",
      });

      expect(retried.found).toBe(true);
      expect(retried.retried).toBe(true);
      if (!retried.retried) {
        throw new Error("Expected blocked flow retry");
      }
      if (!retried.previousTask || !retried.task) {
        throw new Error("Expected retry result payload");
      }
      expect(retried.previousTask.taskId).toBe(created.taskId);
      expect(retried.task.parentFlowId).toBe(parentFlowId);
      expect(retried.task.parentTaskId).toBe(created.taskId);
      expect(retried.task.status).toBe("queued");
      expect(retried.task.runId).toBe("run-executor-retry");
      const queuedFlow = getTaskFlowById(parentFlowId);
      expect(queuedFlow?.flowId).toBe(parentFlowId);
      expect(queuedFlow?.status).toBe("queued");
      expect(findLatestTaskForFlowId(parentFlowId)?.runId).toBe("run-executor-retry");
      const original = findTaskByRunId("run-executor-blocked");
      expect(original?.taskId).toBe(created.taskId);
      expect(original?.status).toBe("succeeded");
      expect(original?.terminalOutcome).toBe("blocked");
      expect(original?.terminalSummary).toBe("Writable session required.");
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
          channel: "notifychat",
          to: "notifychat:123",
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

      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(true);
      const task = findTaskByRunId("run-linear-cancel");
      expect(task?.taskId).toBe(child.taskId);
      expect(task?.status).toBe("cancelled");
      const cancelledFlow = getTaskFlowById(flow.flowId);
      expect(cancelledFlow?.flowId).toBe(flow.flowId);
      expect(cancelledFlow?.status).toBe("cancelled");
    });
  });

  it("runs child tasks under managed TaskFlows", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
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

      expect(created.found).toBe(true);
      expect(created.created).toBe(true);
      if (!created.created) {
        throw new Error("Expected managed flow child task creation");
      }
      if (!created.task) {
        throw new Error("Expected managed flow child task payload");
      }
      expect(created.task.parentFlowId).toBe(flow.flowId);
      expect(created.task.ownerKey).toBe("agent:main:main");
      expect(created.task.status).toBe("running");
      expect(created.task.runId).toBe("run-flow-child");
      const createdTask = requireCreatedFlowTask(created);
      const task = getTaskById(createdTask.taskId);
      expect(task?.parentFlowId).toBe(flow.flowId);
      expect(task?.ownerKey).toBe("agent:main:main");
      expect(task?.childSessionKey).toBe("agent:codex:acp:child");
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

      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(true);

      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-after-cancel",
        task: "Should be denied",
      });

      expect(created.found).toBe(true);
      expect(created.created).toBe(false);
      expect(created.reason).toBe("Flow cancellation has already been requested.");
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
      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-sticky-cancel",
        task: "Inspect a PR",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      });
      const child = requireCreatedFlowTask(created);

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(false);
      expect(cancelled.reason).toBe("One or more child tasks are still active.");
      expect(cancelled.flow?.flowId).toBe(flow.flowId);
      expect(cancelled.flow?.status).toBe("queued");
      const cancelRequestedAt = expectCancelRequestedAt(cancelled.flow?.cancelRequestedAt);

      failTaskRunByRunId({
        runId: "run-flow-sticky-cancel",
        endedAt: 50,
        lastEventAt: 50,
        error: "cancel completed later",
        status: "cancelled",
      });

      const task = getTaskById(child.taskId);
      expect(task?.taskId).toBe(child.taskId);
      expect(task?.status).toBe("cancelled");
      const cancelledFlow = getTaskFlowById(flow.flowId);
      expect(cancelledFlow?.flowId).toBe(flow.flowId);
      expect(cancelledFlow?.cancelRequestedAt).toBe(cancelRequestedAt);
      expect(cancelledFlow?.status).toBe("cancelled");
      expect(cancelledFlow?.endedAt).toBe(50);
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

      expect(cancelled.found).toBe(false);
      expect(cancelled.cancelled).toBe(false);
      expect(cancelled.reason).toBe("Flow not found.");
      const storedFlow = getTaskFlowById(flow.flowId);
      expect(storedFlow?.flowId).toBe(flow.flowId);
      expect(storedFlow?.status).toBe("queued");
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

      expect(created.found).toBe(false);
      expect(created.created).toBe(false);
      expect(created.reason).toBe("Flow not found.");
      expect(findLatestTaskForFlowId(flow.flowId)).toBeUndefined();
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningAcpChildTaskRun({
        runId: "run-linear-cancel",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expectCancelledAcpChildTask(child, cancelled);
    });
  });

  it("dispatches detached task cancellation through the registered runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningAcpChildTaskRun({
        runId: "run-external-cancel",
      });

      const cancelDetachedTaskRunByIdSpy = spyOnRuntimeCancel();

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: child.taskId,
      });
      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(true);
    });
  });

  it("falls back to the legacy canceller when the registered runtime declines task ownership", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningAcpChildTaskRun({
        runId: "run-runtime-decline-cancel",
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
      expectCancelledAcpChildTask(child, cancelled);
    });
  });

  it("does not fall back when the registered runtime claims task ownership", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningAcpChildTaskRun({
        runId: "run-runtime-owned-cancel",
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

      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(false);
      expect(cancelled.reason).toBe("runtime refused cancel");
      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: child.taskId,
      });
      const task = getTaskById(child.taskId);
      expect(task?.taskId).toBe(child.taskId);
      expect(task?.status).toBe("running");
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

      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(true);
      const task = getTaskById(child.taskId);
      expect(task?.taskId).toBe(child.taskId);
      expect(task?.status).toBe("cancelled");
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

      const cancelDetachedTaskRunByIdSpy = spyOnRuntimeCancel();

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: childTask.taskId,
      });
      expect(cancelled.found).toBe(true);
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.flow?.flowId).toBe(flow.flowId);
      expect(cancelled.flow?.status).toBe("cancelled");
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

      const attackerTask = getTaskById(attacker.taskId);
      expect(attackerTask?.status).toBe("failed");
      expect(attackerTask?.error).toBe("attacker controlled error");
      expect(getTaskById(victim.taskId)?.status).toBe("running");
    });
  });
});
