import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDetachedTaskLifecycleRuntime,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import {
  getRuntimeTaskMocks,
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTaskFlows, createRuntimeTaskRuns } from "./runtime-tasks.js";

const runtimeTaskMocks = getRuntimeTaskMocks();

afterEach(() => {
  resetRuntimeTaskTestState();
});

describe("runtime tasks", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("exposes canonical task and TaskFlow DTOs without leaking raw registry fields", () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });
    const taskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:other",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Review inbox",
      currentStep: "triage",
      stateJson: { lane: "priority" },
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-run",
      label: "Inbox triage",
      task: "Review PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 11,
      progressSummary: "Inspecting",
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    expect(taskFlows.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.flowId,
          ownerKey: "agent:main:main",
          goal: "Review inbox",
          currentStep: "triage",
        }),
      ]),
    );
    expect(taskFlows.get(created.flowId)).toMatchObject({
      id: created.flowId,
      ownerKey: "agent:main:main",
      goal: "Review inbox",
      currentStep: "triage",
      state: { lane: "priority" },
      taskSummary: {
        total: 1,
        active: 1,
      },
      tasks: [
        expect.objectContaining({
          id: child.task.taskId,
          flowId: created.flowId,
          title: "Review PR 1",
          label: "Inbox triage",
          runId: "runtime-task-run",
        }),
      ],
    });
    expect(taskRuns.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child.task.taskId,
          flowId: created.flowId,
          sessionKey: "agent:main:main",
          title: "Review PR 1",
          status: "running",
        }),
      ]),
    );
    expect(taskRuns.get(child.task.taskId)).toMatchObject({
      id: child.task.taskId,
      flowId: created.flowId,
      title: "Review PR 1",
      progressSummary: "Inspecting",
    });
    expect(taskRuns.findLatest()?.id).toBe(child.task.taskId);
    expect(taskRuns.resolve("runtime-task-run")?.id).toBe(child.task.taskId);
    expect(taskFlows.getTaskSummary(created.flowId)).toMatchObject({
      total: 1,
      active: 1,
    });

    expect(otherTaskFlows.get(created.flowId)).toBeUndefined();
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();

    const flowDetail = taskFlows.get(created.flowId);
    expect(flowDetail).not.toHaveProperty("revision");
    expect(flowDetail).not.toHaveProperty("controllerId");
    expect(flowDetail).not.toHaveProperty("syncMode");

    const taskDetail = taskRuns.get(child.task.taskId);
    expect(taskDetail).not.toHaveProperty("taskId");
    expect(taskDetail).not.toHaveProperty("requesterSessionKey");
    expect(taskDetail).not.toHaveProperty("scopeKind");
  });

  it("maps task cancellation results onto canonical task DTOs", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Cancel active task",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-cancel",
      task: "Cancel me",
      status: "running",
      startedAt: 20,
      lastEventAt: 21,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await taskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(runtimeTaskMocks.cancelSessionMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "agent:main:subagent:child",
      reason: "task-cancel",
    });
    expect(result).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: child.task.taskId,
        title: "Cancel me",
        status: "cancelled",
      },
    });
  });

  it("routes runtime task cancellation through the detached task runtime seam", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Cancel through runtime seam",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-cancel-seam",
      task: "Cancel via seam",
      status: "running",
      startedAt: 22,
      lastEventAt: 23,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
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

    await taskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
      cfg: {} as never,
      taskId: child.task.taskId,
    });
  });

  it("does not allow cross-owner task cancellation or leak task details", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Keep owner isolation",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-isolation",
      task: "Do not cancel me",
      status: "running",
      startedAt: 30,
      lastEventAt: 31,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await otherTaskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(runtimeTaskMocks.cancelSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();
  });
});
