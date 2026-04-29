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

      expect(created).toMatchObject({
        flowId: created.flowId,
        syncMode: "managed",
        controllerId: "tests/managed-controller",
        revision: 0,
        status: "queued",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });

      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "await_review",
        stateJson: { phase: "await_review" },
        waitJson: { kind: "task", taskId: "task-123" },
      });
      expect(waiting).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          revision: 1,
          status: "waiting",
          currentStep: "await_review",
          waitJson: { kind: "task", taskId: "task-123" },
        }),
      });

      const conflict = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: 0,
        patch: {
          currentStep: "stale",
        },
      });
      expect(conflict).toMatchObject({
        applied: false,
        reason: "revision_conflict",
        current: expect.objectContaining({
          flowId: created.flowId,
          revision: 1,
        }),
      });

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: 1,
        status: "running",
        currentStep: "resume_work",
      });
      expect(resumed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          revision: 2,
          status: "running",
          currentStep: "resume_work",
          waitJson: null,
        }),
      });

      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: 2,
        cancelRequestedAt: 400,
      });
      expect(cancelRequested).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          revision: 3,
          cancelRequestedAt: 400,
        }),
      });

      const failed = failFlow({
        flowId: created.flowId,
        expectedRevision: 3,
        blockedSummary: "Task runner failed.",
        endedAt: 500,
      });
      expect(failed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          revision: 4,
          status: "failed",
          blockedSummary: "Task runner failed.",
          endedAt: 500,
        }),
      });

      expect(listTaskFlowRecords()).toEqual([
        expect.objectContaining({
          flowId: created.flowId,
          revision: 4,
          cancelRequestedAt: 400,
        }),
      ]);

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
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "upserted",
        flow: expect.objectContaining({
          flowId: created.flowId,
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "deleted",
        flowId: created.flowId,
      }),
    );
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

    expect(getTaskFlowById("legacy-managed")).toMatchObject({
      flowId: "legacy-managed",
      syncMode: "managed",
      controllerId: "core/legacy-restored",
    });
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
      expect(blocked).toMatchObject({
        flowId: mirrored.flowId,
        syncMode: "task_mirrored",
        status: "blocked",
        blockedTaskId: "task-blocked",
        blockedSummary: "Writable session required.",
        endedAt: 200,
        updatedAt: 200,
      });

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
      expect(delivered).toMatchObject({
        flowId: mirrored.flowId,
        status: "blocked",
        endedAt: 200,
        updatedAt: 200,
      });

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
      expect(terminalCreated).toMatchObject({
        status: "failed",
        endedAt: 200,
        updatedAt: 200,
      });

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
      expect(syncedManaged).toMatchObject({
        flowId: managed.flowId,
        syncMode: "managed",
        status: "waiting",
        currentStep: "wait_for",
        waitJson: { kind: "external_event" },
      });
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

      expect(created).toMatchObject({
        flowId: created.flowId,
        stateJson: null,
        waitJson: null,
      });

      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        stateJson: null,
      });

      expect(resumed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          stateJson: null,
        }),
      });
    });
  });
});
