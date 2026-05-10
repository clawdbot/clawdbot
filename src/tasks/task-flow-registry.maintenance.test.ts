import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun } from "./task-executor.js";
import {
  createFlowRecord,
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withTaskFlowMaintenanceStateDir(
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-maintenance-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry maintenance", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("finalizes cancel-requested managed flows once no child tasks remain active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected cancel-requested flow to remain registered");
      }
      expect(storedFlow.flowId).toBe(flow.flowId);
      expect(storedFlow.status).toBe("cancelled");
      expect(storedFlow.cancelRequestedAt).toBe(100);
    });
  });

  it("prunes old terminal flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      const oldFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
      });
      expect(getTaskFlowById(oldFlow.flowId)).toBeUndefined();
    });
  });

  it("repairs terminal mirrored flows whose delivery updates outlived endedAt", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createFlowRecord({
        syncMode: "task_mirrored",
        ownerKey: "agent:main:main",
        goal: "Failed ACP task",
        status: "failed",
        createdAt: 100,
        updatedAt: 250,
        endedAt: 200,
      });

      expect(getInspectableTaskFlowAuditSummary().byCode.inconsistent_timestamps).toBe(1);
      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected repaired mirrored flow to remain registered");
      }
      expect(storedFlow.endedAt).toBe(200);
      expect(storedFlow.updatedAt).toBe(200);
      expect(getInspectableTaskFlowAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("does not finalize cancel-requested flows while a child task is still active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait for child cancel",
        status: "running",
        createdAt: 1,
        updatedAt: 100,
      });

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-active-child",
        task: "Inspect repo",
        startedAt: 100,
        lastEventAt: 100,
      });

      const cancelResult = requestFlowCancel({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        cancelRequestedAt: 100,
        updatedAt: 100,
      });
      expect(cancelResult.applied).toBe(true);
      if (!cancelResult.applied) {
        throw new Error("Expected flow cancel request to apply");
      }
      expect(cancelResult.flow.flowId).toBe(flow.flowId);
      expect(cancelResult.flow.cancelRequestedAt).toBe(100);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected active child flow to remain registered");
      }
      expect(storedFlow.flowId).toBe(flow.flowId);
      expect(storedFlow.status).toBe("running");
      expect(storedFlow.cancelRequestedAt).toBe(100);
      expect(child.parentFlowId).toBe(flow.flowId);
    });
  });

  it("prunes many old terminal flows while keeping fresh and active ones", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();

      for (let index = 0; index < 25; index += 1) {
        createManagedTaskFlow({
          ownerKey: `agent:main:${index}`,
          controllerId: "tests/task-flow-maintenance",
          goal: `Old terminal flow ${index}`,
          status: "succeeded",
          createdAt: now - 8 * 24 * 60 * 60_000 - index,
          updatedAt: now - 8 * 24 * 60 * 60_000 - index,
          endedAt: now - 8 * 24 * 60 * 60_000 - index,
        });
      }

      const fresh = createManagedTaskFlow({
        ownerKey: "agent:main:fresh",
        controllerId: "tests/task-flow-maintenance",
        goal: "Fresh terminal flow",
        status: "succeeded",
        createdAt: now - 2 * 24 * 60 * 60_000,
        updatedAt: now - 2 * 24 * 60 * 60_000,
        endedAt: now - 2 * 24 * 60 * 60_000,
      });

      const running = createManagedTaskFlow({
        ownerKey: "agent:main:running",
        controllerId: "tests/task-flow-maintenance",
        goal: "Active flow",
        status: "running",
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 25,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 25,
      });

      const remainingFlowIds = new Set(listTaskFlowRecords().map((flow) => flow.flowId));
      expect(remainingFlowIds).toEqual(new Set([fresh.flowId, running.flowId]));
    });
  });
});
