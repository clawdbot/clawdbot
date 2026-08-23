// Runtime task-flow tests cover plugin task-flow registration and execution behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskFlowForTask, getTaskFlowById } from "../../tasks/task-flow-registry.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";

type BoundTaskFlow = ReturnType<ReturnType<typeof createRuntimeTaskFlow>["bindSession"]>;
type MutationName = "setWaiting" | "resume" | "finish" | "fail" | "requestCancel";

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("runtime TaskFlow", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("binds managed TaskFlow operations to a session key", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Triage inbox",
        currentStep: "classify",
        stateJson: { lane: "inbox" },
      }),
    );

    expect(created.syncMode).toBe("managed");
    expect(created.ownerKey).toBe("agent:main:main");
    expect(created.controllerId).toBe("tests/runtime-taskflow");
    expect(created.requesterOrigin?.channel).toBe("telegram");
    expect(created.requesterOrigin?.to).toBe("telegram:123");
    expect(created.goal).toBe("Triage inbox");
    expect(taskFlow.get(created.flowId)?.flowId).toBe(created.flowId);
    expect(taskFlow.findLatest()?.flowId).toBe(created.flowId);
    expect(taskFlow.resolve("agent:main:main")?.flowId).toBe(created.flowId);
  });

  it("binds TaskFlows from trusted tool context", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.fromToolContext({
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        threadId: "thread:456",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Review queue",
      }),
    );

    expect(created.requesterOrigin?.channel).toBe("discord");
    expect(created.requesterOrigin?.to).toBe("channel:123");
    expect(created.requesterOrigin?.threadId).toBe("thread:456");
  });

  it("rejects tool contexts without a bound session key", () => {
    const runtime = createRuntimeTaskFlow();
    expect(() =>
      runtime.fromToolContext({
        sessionKey: undefined,
        deliveryContext: undefined,
      }),
    ).toThrow("TaskFlow runtime requires tool context with a sessionKey.");
  });

  it("keeps TaskFlow reads owner-scoped and runs child tasks under the bound TaskFlow", () => {
    const runtime = createRuntimeTaskFlow();
    const ownerTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = requireCreatedFlow(
      ownerTaskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Inspect PR batch",
      }),
    );

    expect(otherTaskFlow.get(created.flowId)).toBeUndefined();
    expect(otherTaskFlow.list()).toStrictEqual([]);

    const child = ownerTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-taskflow-child",
      task: "Inspect PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 10,
    });

    expect(child.created).toBe(true);
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }
    expect(child.flow.flowId).toBe(created.flowId);
    expect(child.task.parentFlowId).toBe(created.flowId);
    expect(child.task.ownerKey).toBe("agent:main:main");
    expect(child.task.runId).toBe("runtime-taskflow-child");

    const storedTask = getTaskById(child.task.taskId);
    expect(storedTask?.parentFlowId).toBe(created.flowId);
    expect(storedTask?.ownerKey).toBe("agent:main:main");
    expect(getTaskFlowById(created.flowId)?.flowId).toBe(created.flowId);
    const summary = ownerTaskFlow.getTaskSummary(created.flowId);
    if (!summary) {
      throw new Error("expected task summary for created flow");
    }
    expect(summary.total).toBe(1);
    expect(summary.active).toBe(1);
  });

  it("applies each managed transition exactly once with its explicit payload", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });
    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow/transitions",
        goal: "Apply transitions",
      }),
    );
    const transitions: Array<[name: MutationName, input: Record<string, unknown>, status: string]> =
      [
        [
          "setWaiting",
          {
            currentStep: "await_review",
            stateJson: { phase: "waiting" },
            waitJson: { kind: "approval" },
            blockedTaskId: "task-review",
            blockedSummary: "Review required",
            updatedAt: 20,
          },
          "blocked",
        ],
        [
          "resume",
          {
            status: "running",
            currentStep: "continue_work",
            stateJson: { phase: "running" },
            updatedAt: 30,
          },
          "running",
        ],
        ["finish", { stateJson: { phase: "done" }, updatedAt: 40, endedAt: 41 }, "succeeded"],
        [
          "fail",
          {
            stateJson: { phase: "failed" },
            blockedTaskId: "task-failed",
            blockedSummary: "Task failed",
            updatedAt: 50,
            endedAt: 51,
          },
          "failed",
        ],
        ["requestCancel", { cancelRequestedAt: 60 }, "failed"],
      ];

    for (const [index, [name, input, status]] of transitions.entries()) {
      const mutate = taskFlow[name] as BoundTaskFlow["setWaiting"];
      const result = mutate({
        flowId: created.flowId,
        expectedRevision: index,
        ...input,
      });
      expect(result.applied, name).toBe(true);
      if (!result.applied) {
        throw new Error(`expected ${name} to apply`);
      }
      expect(result.flow, name).toMatchObject({
        ...input,
        status,
        flowId: created.flowId,
        revision: index + 1,
      });
      expect(getTaskFlowById(created.flowId)?.revision, name).toBe(index + 1);
    }
  });

  it("rejects invalid mutation targets before writing and preserves conflict mapping", () => {
    const runtime = createRuntimeTaskFlow();
    const ownerTaskFlow = runtime.bindSession({ sessionKey: "agent:main:main" });
    const otherTaskFlow = runtime.bindSession({ sessionKey: "agent:main:other" });
    const managed = requireCreatedFlow(
      ownerTaskFlow.createManaged({
        controllerId: "tests/runtime-taskflow/auth",
        goal: "Keep ownership",
      }),
    );

    const denied = otherTaskFlow.setWaiting({
      flowId: managed.flowId,
      expectedRevision: managed.revision,
    });
    expect(denied).toEqual({ applied: false, code: "not_found" });
    expect(getTaskFlowById(managed.flowId)?.revision).toBe(0);

    const mirrored = requireCreatedFlow(
      createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-mirrored",
          notifyPolicy: "done_only",
          status: "running",
          task: "Mirror this task",
          createdAt: 10,
          lastEventAt: 10,
        },
      }),
    );
    const wrongMode = ownerTaskFlow.resume({
      flowId: mirrored.flowId,
      expectedRevision: mirrored.revision,
    });
    expect(wrongMode).toMatchObject({ applied: false, code: "not_managed" });

    const conflict = ownerTaskFlow.finish({ flowId: managed.flowId, expectedRevision: 1 });
    expect(conflict).toMatchObject({ applied: false, code: "revision_conflict" });
    expect(getTaskFlowById(managed.flowId)).toMatchObject({
      revision: 0,
      status: "queued",
    });
    expect(getTaskFlowById(managed.flowId)?.endedAt).toBeUndefined();
    expect(getTaskFlowById(mirrored.flowId)?.revision).toBe(0);
  });
});
