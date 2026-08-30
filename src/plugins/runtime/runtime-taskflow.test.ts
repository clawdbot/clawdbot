// Runtime task-flow tests cover plugin task-flow registration and execution behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTINUATION_DELEGATE_CONTROLLER_ID } from "../../auto-reply/continuation/delegate-flow-store.js";
import { createAcpTaskBackingDetailForTest } from "../../tasks/task-backing-authority.test-support.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  createTaskFlowForTask,
  getTaskFlowById,
} from "../../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { getInspectableActiveTaskRestartBlockers } from "../../tasks/task-registry.maintenance.js";
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

function expectPublicContinuationState(flow: TaskFlowRecord | undefined) {
  expect(flow).toBeDefined();
  const state = flow?.stateJson as Record<string, unknown>;
  expect(state.phase).toBe("queued");
  expect(Object.keys(state)).not.toContain("attachments");
  expect(Object.keys(state)).not.toContain("attachAs");
}

afterEach(() => {
  resetRuntimeTaskTestState();
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

    createRunningTaskRunCore({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-taskflow-child",
      task: "Inspect PR 1",
      startedAt: 10,
      detail: createAcpTaskBackingDetailForTest("instance:runtime-taskflow-child"),
    });

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

  it("does not persist continuation input through generic plugin creation", async () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });
    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: ` ${CONTINUATION_DELEGATE_CONTROLLER_ID} `,
        goal: "Continue delegated work",
        stateJson: {
          phase: "queued",
          attachments: [{ name: "brief.md", content: "input-marker" }],
          attachAs: { mountPath: "handoff" },
        },
      }),
    );

    expectPublicContinuationState(created);
    const queuedState = getTaskFlowById(created.flowId)?.stateJson as Record<string, unknown>;
    expect(Object.keys(queuedState)).not.toContain("attachments");
    expect(Object.keys(queuedState)).not.toContain("attachAs");
    expectPublicContinuationState(taskFlow.get(created.flowId));
    expectPublicContinuationState(taskFlow.list()[0]);
    expectPublicContinuationState(taskFlow.findLatest());
    expectPublicContinuationState(taskFlow.resolve("agent:main:main"));

    const cancelled = await taskFlow.cancel({ flowId: created.flowId, cfg: {} });

    expect(cancelled).toMatchObject({ found: true, cancelled: true });
    expectPublicContinuationState(cancelled.flow);
    const terminal = getTaskFlowById(created.flowId);
    expect(terminal?.status).toBe("cancelled");
    const terminalState = terminal?.stateJson as Record<string, unknown>;
    expect(terminalState.phase).toBe("queued");
    expect(Object.keys(terminalState)).not.toContain("attachments");
    expect(Object.keys(terminalState)).not.toContain("attachAs");
  });

  it("persistently scrubs pre-existing continuation input before cancellation", async () => {
    const secret = "PREEXISTING_CONTINUATION_ATTACHMENT_SECRET";
    const seeded = requireCreatedFlow(
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
        goal: "Cancel a pre-existing continuation",
        stateJson: {
          phase: "queued",
          attachments: [{ name: "brief.md", content: secret }],
          attachAs: { mountPath: "handoff" },
        },
      }),
    );
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });

    const cancelled = await taskFlow.cancel({ flowId: seeded.flowId, cfg: {} });

    expect(cancelled).toMatchObject({ found: true, cancelled: true });
    const stored = getTaskFlowById(seeded.flowId);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.stateJson).toEqual({ phase: "queued" });
    expect(JSON.stringify(stored?.stateJson)).not.toContain(secret);
  });

  it("atomically scrubs persisted continuation input when cancellation is requested", () => {
    const secret = "REQUEST_CANCEL_CONTINUATION_ATTACHMENT_SECRET";
    const seeded = requireCreatedFlow(
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
        goal: "Request cancellation for a pre-existing continuation",
        stateJson: {
          phase: "queued",
          attachments: [{ name: "brief.md", content: secret }],
          attachAs: { mountPath: "handoff" },
        },
      }),
    );
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });

    const cancelRequested = taskFlow.requestCancel({
      flowId: seeded.flowId,
      expectedRevision: seeded.revision,
      cancelRequestedAt: 60,
    });

    expect(cancelRequested).toEqual({
      applied: true,
      flow: expect.objectContaining({
        flowId: seeded.flowId,
        revision: seeded.revision + 1,
        cancelRequestedAt: 60,
        stateJson: { phase: "queued" },
      }),
    });
    const stored = getTaskFlowById(seeded.flowId);
    expect(stored).toMatchObject({
      revision: seeded.revision + 1,
      cancelRequestedAt: 60,
      stateJson: { phase: "queued" },
    });
    expect(JSON.stringify(stored?.stateJson)).not.toContain(secret);
  });

  it("does not persist continuation input through plugin waiting or resume transitions", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });
    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
        goal: "Update delegate state through plugin runtime",
        stateJson: { phase: "queued" },
      }),
    );

    const waiting = taskFlow.setWaiting({
      flowId: created.flowId,
      expectedRevision: 0,
      currentStep: "waiting",
      stateJson: {
        phase: "waiting",
        attachments: [{ name: "brief.md", content: "WAITING_PLUGIN_ATTACHMENT_SECRET" }],
        attachAs: { mountPath: "handoff" },
      },
    });
    expect(waiting.applied).toBe(true);
    const waitingState = getTaskFlowById(created.flowId)?.stateJson as Record<string, unknown>;
    expect(waitingState.phase).toBe("waiting");
    expect(Object.keys(waitingState)).not.toContain("attachments");
    expect(Object.keys(waitingState)).not.toContain("attachAs");
    expect(JSON.stringify(waitingState)).not.toContain("WAITING_PLUGIN_ATTACHMENT_SECRET");

    const resumed = taskFlow.resume({
      flowId: created.flowId,
      expectedRevision: 1,
      status: "running",
      currentStep: "resumed",
      stateJson: {
        phase: "running",
        attachments: [{ name: "brief.md", content: "RESUME_PLUGIN_ATTACHMENT_SECRET" }],
        attachAs: { mountPath: "handoff" },
      },
    });
    expect(resumed.applied).toBe(true);
    const resumedState = getTaskFlowById(created.flowId)?.stateJson as Record<string, unknown>;
    expect(resumedState.phase).toBe("running");
    expect(Object.keys(resumedState)).not.toContain("attachments");
    expect(Object.keys(resumedState)).not.toContain("attachAs");
    expect(JSON.stringify(resumedState)).not.toContain("RESUME_PLUGIN_ATTACHMENT_SECRET");
  });

  it("scrubs continuation input from bound terminal transitions", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });
    const transitions = [
      {
        name: "finish",
        run: (flowId: string) => taskFlow.finish({ flowId, expectedRevision: 0 }),
        status: "succeeded",
      },
      {
        name: "fail",
        run: (flowId: string) =>
          taskFlow.fail({
            flowId,
            expectedRevision: 0,
            stateJson: {
              phase: "failed",
              attachments: [{ name: "result.md", content: "private-input" }],
              attachAs: { mountPath: "handoff" },
            },
          }),
        status: "failed",
      },
    ] as const;

    for (const transition of transitions) {
      const created = requireCreatedFlow(
        taskFlow.createManaged({
          controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
          goal: `Terminal ${transition.name}`,
          stateJson: {
            phase: "queued",
            attachments: [{ name: "brief.md", content: "private-input" }],
            attachAs: { mountPath: "handoff" },
          },
        }),
      );

      const result = transition.run(created.flowId);
      expect(result.applied, transition.name).toBe(true);
      if (!result.applied) {
        throw new Error(`expected ${transition.name} to apply`);
      }

      const terminal = getTaskFlowById(created.flowId);
      expect(terminal?.status, transition.name).toBe(transition.status);
      const terminalState = terminal?.stateJson as Record<string, unknown>;
      expect(Object.keys(terminalState), transition.name).not.toContain("attachments");
      expect(Object.keys(terminalState), transition.name).not.toContain("attachAs");
    }
  });

  it("preserves explicit null terminal state for continuation flows", () => {
    const taskFlow = createRuntimeTaskFlow().bindSession({ sessionKey: "agent:main:main" });
    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
        goal: "Clear terminal state",
        stateJson: {
          phase: "queued",
          attachments: [{ name: "brief.md", content: "private-input" }],
          attachAs: { mountPath: "handoff" },
        },
      }),
    );

    const finished = taskFlow.finish({
      flowId: created.flowId,
      expectedRevision: 0,
      stateJson: null,
    });

    expect(finished.applied).toBe(true);
    expect(getTaskFlowById(created.flowId)?.stateJson).toBeNull();
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

  // Declared last on purpose: it observes what the earlier tests' afterEach
  // resets left behind. A reset that keeps durable rows lets
  // ensureTaskRegistryReady() restore them here, and every later test file in
  // this isolate:false worker then inherits phantom active restart blockers.
  it("leaves no restorable task restart blockers for later test files", () => {
    expect(getInspectableActiveTaskRestartBlockers()).toStrictEqual([]);
  });
});
