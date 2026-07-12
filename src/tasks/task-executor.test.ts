// Covers task executor runtime selection, lifecycle updates, and error paths.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { captureEnv } from "../test-utils/env.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
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
  createQueuedTaskRun as createQueuedTaskRunOrNull,
  createRunningTaskRun as createRunningTaskRunOrNull,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  runTaskInFlow,
  runTaskInFlowForOwner,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  setTaskRegistryDeliveryRuntimeForTests,
  getTaskById,
  findLatestTaskForFlowId,
  findTaskByRunId,
  markTaskTerminalById,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function createQueuedTaskRun(params: Parameters<typeof createQueuedTaskRunOrNull>[0]): TaskRecord {
  const task = createQueuedTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected queued task creation to succeed");
  }
  return task;
}

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}
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
    ORIGINAL_ENV.restore();
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

  it("keeps detached tasks standalone when task-flow restore fails", async () => {
    await withTaskExecutorStateDir(async () => {
      const loadSnapshot = vi.fn(() => {
        throw new Error("SQLITE_IOERR: task-flow restore failed");
      });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot,
          saveSnapshot: () => {},
        },
      });

      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:standalone",
        runId: "run-executor-flow-restore-failed",
        task: "Continue without a one-task flow",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      expect(created.parentFlowId).toBeUndefined();
      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "running",
        parentFlowId: undefined,
      });
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes a provisional kill in an already-cancelled one-task flow", async () => {
    await withTaskExecutorStateDir(async () => {
      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:worker:subagent:mirrored-kill",
        runId: "run-mirrored-provisional-kill",
        task: "Stop mirrored child",
        startedAt: 10,
        deliveryStatus: "pending",
      });
      const flowId = expectParentFlowId(child);
      failTaskRunByRunId({
        runId: child.runId!,
        runtime: "subagent",
        sessionKey: child.childSessionKey,
        status: "cancelled",
        endedAt: 20,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: child.runId!,
        sessionKey: child.childSessionKey!,
        targetState: {
          state: "terminal",
          task: { status: "cancelled", endedAt: 20, error: SUBAGENT_KILL_TASK_ERROR },
        },
      });
      expect(getTaskFlowById(flowId)?.status).toBe("cancelled");

      const cancelled = await cancelFlowById({ cfg: {} as never, flowId });
      completeTaskRunByRunId({
        runId: child.runId!,
        runtime: "subagent",
        sessionKey: child.childSessionKey,
        endedAt: 30,
        terminalSummary: "completed too late",
      });

      expect(cancelled).toMatchObject({ found: true, cancelled: true });
      expect(getTaskFlowById(flowId)?.status).toBe("cancelled");
      expect(getTaskById(child.taskId)).toMatchObject({
        status: "cancelled",
        endedAt: 20,
        error: "Cancelled by operator.",
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
      expect(listTaskFlowRecords()).toStrictEqual([]);
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

  it("promotes provisional subagent kills before cancelling a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Cancel a killed child",
      });
      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "subagent",
        childSessionKey: "agent:worker:subagent:flow-killed",
        runId: "run-flow-provisional-kill",
        task: "Stop the child",
        status: "running",
        startedAt: 10,
      });
      const child = requireCreatedFlowTask(created);
      failTaskRunByRunId({
        runId: child.runId!,
        runtime: "subagent",
        sessionKey: child.childSessionKey,
        status: "cancelled",
        endedAt: 20,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: child.runId!,
        sessionKey: child.childSessionKey!,
        targetState: {
          state: "terminal",
          task: { status: "cancelled", endedAt: 20, error: SUBAGENT_KILL_TASK_ERROR },
        },
      });

      const cancelled = await cancelFlowById({ cfg: {} as never, flowId: flow.flowId });
      completeTaskRunByRunId({
        runId: child.runId!,
        runtime: "subagent",
        sessionKey: child.childSessionKey,
        endedAt: 30,
        terminalSummary: "completed too late",
      });

      expect(cancelled).toMatchObject({ found: true, cancelled: true });
      expect(getTaskFlowById(flow.flowId)?.status).toBe("cancelled");
      expect(getTaskById(child.taskId)).toMatchObject({
        status: "cancelled",
        endedAt: 20,
        error: "Cancelled by operator.",
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

  it("dispatches cancellation for tasks owned only by the registered runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      const cancelDetachedTaskRunByIdSpy = vi.fn(async () => ({
        found: true,
        cancelled: true,
      }));
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: "runtime-owned-task",
        reason: "operator request",
      });

      expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
        cfg: {} as never,
        taskId: "runtime-owned-task",
        reason: "operator request",
      });
      expect(cancelled).toEqual({
        found: true,
        cancelled: true,
      });
    });
  });

  it("checks linked flow readiness before invoking a registered cancellation runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      const child = createRunningAcpChildTaskRun({
        runId: "run-external-cancel-restore-failed",
      });
      expect(child.parentFlowId).toBeTruthy();
      const cancelDetachedTaskRunByIdSpy = spyOnRuntimeCancel();

      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => {
            throw new Error("SQLITE_IOERR: cancellation flow restore failed");
          },
          saveSnapshot: () => {},
        },
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelDetachedTaskRunByIdSpy).not.toHaveBeenCalled();
      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: expect.stringContaining(
          "Task-flow registry restore failed: SQLITE_IOERR: cancellation flow restore failed",
        ),
        task: {
          taskId: child.taskId,
          status: "running",
        },
      });
      expect(getTaskById(child.taskId)?.status).toBe("running");
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

  it("dispatches provisional terminal projections to their registered runtime", async () => {
    await withTaskExecutorStateDir(async () => {
      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:provisional",
        runId: "run-provisional-runtime-owned",
        task: "Cancel provisional runtime task",
        startedAt: 10,
        deliveryStatus: "not_applicable",
      });
      markTaskTerminalById({
        taskId: child.taskId,
        status: "cancelled",
        endedAt: 20,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      const cancelDetachedTaskRunByIdSpy = vi.fn(async () => ({
        found: true,
        cancelled: true,
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
      expect(cancelled).toEqual({
        found: true,
        cancelled: true,
      });
    });
  });

  it("checks linked flow readiness before dispatching provisional terminal projections", async () => {
    await withTaskExecutorStateDir(async () => {
      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:provisional-restore-failed",
        runId: "run-provisional-runtime-restore-failed",
        task: "Gate provisional runtime cancellation",
        startedAt: 10,
        deliveryStatus: "pending",
      });
      expect(child.parentFlowId).toBeTruthy();
      markTaskTerminalById({
        taskId: child.taskId,
        status: "cancelled",
        endedAt: 20,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      const cancelDetachedTaskRunByIdSpy = vi.fn(async () => ({
        found: true,
        cancelled: true,
      }));
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
      });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => {
            throw new Error("SQLITE_IOERR: provisional cancellation restore failed");
          },
          saveSnapshot: () => {},
        },
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelDetachedTaskRunByIdSpy).not.toHaveBeenCalled();
      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: expect.stringContaining(
          "Task-flow registry restore failed: SQLITE_IOERR: provisional cancellation restore failed",
        ),
      });
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
