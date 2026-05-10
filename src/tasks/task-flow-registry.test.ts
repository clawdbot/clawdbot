import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createFlowRecord,
  createTaskFlowForTask,
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  failFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  syncFlowFromTask,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-flow-registry-" },
    async (state) => {
      resetTaskFlowRegistryForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskFlowRegistryForTests();
  });

  it("creates managed flows and updates them through revision-checked helpers", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Investigate flaky test",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });

      expect(created.flowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.syncMode).toBe("managed");
      expect(created.controllerId).toBe("tests/managed-controller");
      expect(created.revision).toBe(0);
      expect(created.status).toBe("queued");
      expect(created.currentStep).toBe("spawn_task");
      expect(created.stateJson).toEqual({ phase: "spawn" });

      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "await_review",
        stateJson: { phase: "await_review" },
        waitJson: { kind: "task", taskId: "task-123" },
      });
      expect(waiting.applied).toBe(true);
      if (!waiting.applied) {
        throw new Error("Expected wait state update to apply");
      }
      expect(waiting.flow.flowId).toBe(created.flowId);
      expect(waiting.flow.revision).toBe(1);
      expect(waiting.flow.status).toBe("waiting");
      expect(waiting.flow.currentStep).toBe("await_review");
      expect(waiting.flow.waitJson).toEqual({ kind: "task", taskId: "task-123" });

      const conflict = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: 0,
        patch: {
          currentStep: "stale",
        },
      });
      expect(conflict.applied).toBe(false);
      if (conflict.applied) {
        throw new Error("Expected stale revision update to conflict");
      }
      expect(conflict.reason).toBe("revision_conflict");
      expect(conflict.current?.flowId).toBe(created.flowId);
      expect(conflict.current?.revision).toBe(1);

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: 1,
        status: "running",
        currentStep: "resume_work",
      });
      expect(resumed.applied).toBe(true);
      if (!resumed.applied) {
        throw new Error("Expected resume update to apply");
      }
      expect(resumed.flow.flowId).toBe(created.flowId);
      expect(resumed.flow.revision).toBe(2);
      expect(resumed.flow.status).toBe("running");
      expect(resumed.flow.currentStep).toBe("resume_work");
      expect(resumed.flow.waitJson).toBeNull();

      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: 2,
        cancelRequestedAt: 400,
      });
      expect(cancelRequested.applied).toBe(true);
      if (!cancelRequested.applied) {
        throw new Error("Expected cancel request update to apply");
      }
      expect(cancelRequested.flow.flowId).toBe(created.flowId);
      expect(cancelRequested.flow.revision).toBe(3);
      expect(cancelRequested.flow.cancelRequestedAt).toBe(400);

      const failed = failFlow({
        flowId: created.flowId,
        expectedRevision: 3,
        blockedSummary: "Task runner failed.",
        endedAt: 500,
      });
      expect(failed.applied).toBe(true);
      if (!failed.applied) {
        throw new Error("Expected fail update to apply");
      }
      expect(failed.flow.flowId).toBe(created.flowId);
      expect(failed.flow.revision).toBe(4);
      expect(failed.flow.status).toBe("failed");
      expect(failed.flow.blockedSummary).toBe("Task runner failed.");
      expect(failed.flow.endedAt).toBe(500);

      const flows = listTaskFlowRecords();
      expect(flows).toHaveLength(1);
      expect(flows[0]?.flowId).toBe(created.flowId);
      expect(flows[0]?.revision).toBe(4);
      expect(flows[0]?.cancelRequestedAt).toBe(400);

      expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
      expect(getTaskFlowById(created.flowId)).toBeUndefined();
    });
  });

  it("requires a controller for managed flows and rejects clearing it later", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      expect(() =>
        createFlowRecord({
          ownerKey: "agent:main:main",
          goal: "Missing controller",
        }),
      ).toThrow("Managed flow controllerId is required.");

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Protected controller",
      });

      expect(() =>
        updateFlowRecordByIdExpectedRevision({
          flowId: created.flowId,
          expectedRevision: created.revision,
          patch: {
            controllerId: null,
          },
        }),
      ).toThrow("Managed flow controllerId is required.");
    });
  });

  it("emits restored, upserted, and deleted flow observer events", () => {
    const onEvent = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
      },
      observers: {
        onEvent,
      },
    });

    const created = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/observers",
      goal: "Observe observers",
    });

    deleteTaskFlowRecordById(created.flowId);

    expect(onEvent).toHaveBeenCalledWith({
      kind: "restored",
      flows: [],
    });
    const events = onEvent.mock.calls.map((call) => call[0]);
    expect(events[1]?.kind).toBe("upserted");
    expect(events[1]?.flow?.flowId).toBe(created.flowId);
    expect(events[2]?.kind).toBe("deleted");
    expect(events[2]?.flowId).toBe(created.flowId);
  });

  it("normalizes restored managed flows without a controller id", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map([
            [
              "legacy-managed",
              {
                flowId: "legacy-managed",
                syncMode: "managed",
                ownerKey: "agent:main:main",
                revision: 0,
                status: "queued",
                notifyPolicy: "done_only",
                goal: "Legacy managed flow",
                createdAt: 10,
                updatedAt: 10,
              },
            ],
          ]),
        }),
        saveSnapshot: () => {},
      },
    });

    const restored = getTaskFlowById("legacy-managed");
    expect(restored?.flowId).toBe("legacy-managed");
    expect(restored?.syncMode).toBe("managed");
    expect(restored?.controllerId).toBe("core/legacy-restored");
  });

  it("mirrors one-task flow state from tasks and leaves managed flows alone", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const mirrored = createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-running",
          notifyPolicy: "done_only",
          status: "running",
          label: "Fix permissions",
          task: "Fix permissions",
          createdAt: 100,
          lastEventAt: 100,
        },
      });

      const blocked = syncFlowFromTask({
        taskId: "task-blocked",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 200,
        endedAt: 200,
        terminalSummary: "Writable session required.",
      });
      if (!blocked) {
        throw new Error("Expected blocked mirrored flow update");
      }
      expect(blocked.flowId).toBe(mirrored.flowId);
      expect(blocked.syncMode).toBe("task_mirrored");
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockedTaskId).toBe("task-blocked");
      expect(blocked.blockedSummary).toBe("Writable session required.");
      expect(blocked.endedAt).toBe(200);
      expect(blocked.updatedAt).toBe(200);

      const delivered = syncFlowFromTask({
        taskId: "task-blocked",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 250,
        endedAt: 200,
        terminalSummary: "Writable session required.",
      });
      if (!delivered) {
        throw new Error("Expected repeated mirrored flow update");
      }
      expect(delivered.flowId).toBe(mirrored.flowId);
      expect(delivered.status).toBe("blocked");
      expect(delivered.endedAt).toBe(200);
      expect(delivered.updatedAt).toBe(200);

      const terminalCreated = createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-failed",
          notifyPolicy: "done_only",
          status: "failed",
          label: "Fail permissions",
          task: "Fail permissions",
          createdAt: 100,
          lastEventAt: 300,
          endedAt: 200,
        },
      });
      expect(terminalCreated.status).toBe("failed");
      expect(terminalCreated.endedAt).toBe(200);
      expect(terminalCreated.updatedAt).toBe(200);

      const managed = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed",
        goal: "Cluster PRs",
        currentStep: "wait_for",
        status: "waiting",
        waitJson: { kind: "external_event" },
      });
      const syncedManaged = syncFlowFromTask({
        taskId: "task-child",
        parentFlowId: managed.flowId,
        status: "running",
        notifyPolicy: "done_only",
        label: "Child task",
        task: "Child task",
        lastEventAt: 250,
        progressSummary: "Running child task",
      });
      if (!syncedManaged) {
        throw new Error("Expected managed flow sync result");
      }
      expect(syncedManaged.flowId).toBe(managed.flowId);
      expect(syncedManaged.syncMode).toBe("managed");
      expect(syncedManaged.status).toBe("waiting");
      expect(syncedManaged.currentStep).toBe("wait_for");
      expect(syncedManaged.waitJson).toEqual({ kind: "external_event" });
    });
  });

  it("preserves explicit json null in state and wait payloads", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-state",
        goal: "Null payloads",
        stateJson: null,
        waitJson: null,
      });

      expect(created.flowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.stateJson).toBeNull();
      expect(created.waitJson).toBeNull();

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        stateJson: null,
      });

      expect(resumed.applied).toBe(true);
      if (!resumed.applied) {
        throw new Error("Expected resume update to apply");
      }
      expect(resumed.flow.flowId).toBe(created.flowId);
      expect(resumed.flow.stateJson).toBeNull();
    });
  });
});
