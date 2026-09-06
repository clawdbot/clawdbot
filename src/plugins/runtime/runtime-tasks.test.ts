// Runtime task tests cover plugin task runtime registration, invocation, and cleanup.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { createAcpTaskBackingDetailForTest } from "../../tasks/task-backing-authority.test-support.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { createTaskRecord } from "../../tasks/task-registry.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import {
  getRuntimeTaskMocks,
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";

const runtimeTaskMocks = getRuntimeTaskMocks();

afterEach(() => {
  resetRuntimeTaskTestState();
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requireRecordById(items: readonly unknown[], id: string): Record<string, unknown> {
  for (const item of items) {
    const record = requireRecord(item);
    if (record.id === id) {
      return record;
    }
  }
  throw new Error(`Missing record ${id}`);
}

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createCanonicalAcpTask(runId: string) {
  const task = createRunningTaskRunCore({
    runtime: "acp",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:child",
    runId,
    task: "Canonical child",
    startedAt: 10,
    deliveryStatus: "pending",
    detail: createAcpTaskBackingDetailForTest(`instance:${runId}`),
  });
  if (!task) {
    throw new Error("expected canonical backing task creation to succeed");
  }
  return task;
}

describe("runtime tasks", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("exposes canonical task and TaskFlow DTOs without leaking raw registry fields", () => {
    const runtimeTasks = createRuntimeTasks({
      managedTaskFlow: createRuntimeTaskFlow(),
    });
    const legacyTaskFlow = runtimeTasks.managedFlows.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });
    const taskFlows = runtimeTasks.flows.bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlows = runtimeTasks.flows.bindSession({
      sessionKey: "agent:main:other",
    });
    const otherTaskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Review inbox",
        currentStep: "triage",
        stateJson: { lane: "priority" },
      }),
    );
    createCanonicalAcpTask("runtime-task-run");
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

    const listedFlow = requireRecordById(taskFlows.list(), created.flowId);
    expect(listedFlow.ownerKey).toBe("agent:main:main");
    expect(listedFlow.goal).toBe("Review inbox");
    expect(listedFlow.currentStep).toBe("triage");

    const flow = requireRecord(taskFlows.get(created.flowId));
    expect(flow.id).toBe(created.flowId);
    expect(flow.ownerKey).toBe("agent:main:main");
    expect(flow.goal).toBe("Review inbox");
    expect(flow.currentStep).toBe("triage");
    expect(flow.state).toEqual({ lane: "priority" });
    const taskSummary = requireRecord(flow.taskSummary);
    expect(taskSummary.total).toBe(1);
    expect(taskSummary.active).toBe(1);
    const flowTasks = flow.tasks;
    expect(Array.isArray(flowTasks)).toBe(true);
    const flowTask = requireRecordById(flowTasks as unknown[], child.task.taskId);
    expect(flowTask.flowId).toBe(created.flowId);
    expect(flowTask.title).toBe("Review PR 1");
    expect(flowTask.label).toBe("Inbox triage");
    expect(flowTask.runId).toBe("runtime-task-run");

    const listedRun = requireRecordById(taskRuns.list(), child.task.taskId);
    expect(listedRun.flowId).toBe(created.flowId);
    expect(listedRun.sessionKey).toBe("agent:main:main");
    expect(listedRun.title).toBe("Review PR 1");
    expect(listedRun.status).toBe("running");
    const taskRun = requireRecord(taskRuns.get(child.task.taskId));
    expect(taskRun.id).toBe(child.task.taskId);
    expect(taskRun.flowId).toBe(created.flowId);
    expect(taskRun.title).toBe("Review PR 1");
    expect(taskRun.progressSummary).toBe("Inspecting");
    expect(taskRuns.findLatest()?.id).toBe(child.task.taskId);
    expect(taskRuns.resolve(child.task.taskId)?.id).toBe(child.task.taskId);
    const summary = requireRecord(taskFlows.getTaskSummary(created.flowId));
    expect(summary.total).toBe(1);
    expect(summary.active).toBe(1);

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
    const runtimeTasks = createRuntimeTasks({
      managedTaskFlow: createRuntimeTaskFlow(),
    });
    const legacyTaskFlow = runtimeTasks.managedFlows.bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Cancel active task",
      }),
    );
    createCanonicalAcpTask("runtime-task-cancel");
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
      agentId: "main",
      sessionKey: "agent:main:subagent:child",
      reason: "task-cancel",
      expectedRunId: "runtime-task-cancel",
      expectedInstanceId: "instance:runtime-task-cancel",
      expectedOwnerKey: "agent:main:main",
    });
    expect(result.found).toBe(true);
    expect(result.cancelled).toBe(true);
    const task = requireRecord(result.task);
    expect(task.id).toBe(child.task.taskId);
    expect(task.title).toBe("Cancel me");
    expect(task.status).toBe("cancelled");
  });

  it("routes runtime task cancellation through the detached task runtime seam", async () => {
    const runtimeTasks = createRuntimeTasks({
      managedTaskFlow: createRuntimeTaskFlow(),
    });
    const legacyTaskFlow = runtimeTasks.managedFlows.bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Cancel through runtime seam",
      }),
    );
    createCanonicalAcpTask("runtime-task-cancel-seam");
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
    const runtimeTasks = createRuntimeTasks({
      managedTaskFlow: createRuntimeTaskFlow(),
    });
    const legacyTaskFlow = runtimeTasks.managedFlows.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Keep owner isolation",
      }),
    );
    createCanonicalAcpTask("runtime-task-isolation");
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

  it("isolates task runs for agents sharing a bare session key", async () => {
    const runtimeTasks = createRuntimeTasks({
      managedTaskFlow: createRuntimeTaskFlow(),
    });
    const opsTaskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "global",
      agentId: "ops",
    });
    const researchTaskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "global",
      agentId: "research",
    });
    const agentlessTaskRuns = runtimeTasks.runs.bindSession({
      sessionKey: "global",
    });
    const opsTask = createTaskRecord({
      runtime: "acp",
      ownerKey: "global",
      scopeKind: "session",
      requesterAgentId: "ops",
      childSessionKey: "agent:ops:acp:child",
      runId: "ops-global-run",
      task: "Ops global task",
      status: "running",
    });
    const researchTask = createTaskRecord({
      runtime: "acp",
      ownerKey: "global",
      scopeKind: "session",
      requesterAgentId: "research",
      childSessionKey: "agent:research:acp:child",
      runId: "research-global-run",
      task: "Research global task",
      status: "running",
    });
    if (!opsTask || !researchTask) {
      throw new Error("expected paired global tasks to be created");
    }

    expect(opsTaskRuns.get(opsTask.taskId)?.id).toBe(opsTask.taskId);
    expect(opsTaskRuns.list().map((task) => task.id)).toEqual([opsTask.taskId]);
    expect(opsTaskRuns.resolve("ops-global-run")?.id).toBe(opsTask.taskId);

    expect(researchTaskRuns.get(opsTask.taskId)).toBeUndefined();
    expect(researchTaskRuns.list().map((task) => task.id)).toEqual([researchTask.taskId]);
    expect(researchTaskRuns.resolve("ops-global-run")).toBeUndefined();
    expect(agentlessTaskRuns.get(opsTask.taskId)).toBeUndefined();
    expect(agentlessTaskRuns.list()).toEqual([]);
    expect(agentlessTaskRuns.resolve("ops-global-run")).toBeUndefined();

    const researchCancel = await researchTaskRuns.cancel({
      taskId: opsTask.taskId,
      cfg: {} as never,
    });
    expect(researchCancel).toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    const agentlessCancel = await agentlessTaskRuns.cancel({
      taskId: opsTask.taskId,
      cfg: {} as never,
    });
    expect(agentlessCancel).toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(runtimeTaskMocks.cancelSessionMock).not.toHaveBeenCalled();

    const opsCancel = await opsTaskRuns.cancel({
      taskId: opsTask.taskId,
      cfg: {} as never,
    });
    expect(opsCancel.found).toBe(true);
    expect(opsCancel.cancelled).toBe(true);
    expect(runtimeTaskMocks.cancelSessionMock).toHaveBeenCalledWith({
      cfg: {},
      agentId: "ops",
      sessionKey: "agent:ops:acp:child",
      reason: "task-cancel",
      expectedRunId: "ops-global-run",
    });
  });
});
