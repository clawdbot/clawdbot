import { afterEach, describe, expect, it, vi } from "vitest";
import { flowsCancelCommand, flowsListCommand, flowsShowCommand } from "../commands/flows.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun as createRunningTaskRunOrNull,
} from "./task-executor.js";
import { getTaskFlowByIdForOwner, listTaskFlowsForOwner } from "./task-flow-owner-access.js";
import { listTaskFlowAuditFindings } from "./task-flow-registry.audit.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  finishFlow,
  getTaskFlowById,
  reloadTaskFlowRegistryFromStore,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "./task-flow-registry.js";
import type { TaskFlowUpdateResult } from "./task-flow-registry.js";
import {
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskById, reloadTaskRegistryFromStore } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const OWNER_KEY = "agent:main:a08";
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

type TestRuntime = RuntimeEnv & {
  writeStdout: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createRuntime(): TestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function requireManagedFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function requireTask(params: Parameters<typeof createRunningTaskRunOrNull>[0]): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

function requireApplied(result: TaskFlowUpdateResult): TaskFlowRecord {
  if (!result.applied) {
    throw new Error(`expected TaskFlow update to apply, got ${result.reason}`);
  }
  return result.flow;
}

function resetFlowTestState(): void {
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetConfigRuntimeState();
}

afterEach(() => {
  resetFlowTestState();
});

describe("task-flow registry product boundary", () => {
  it("runs managed, mirrored, CLI, audit, and maintenance lifecycles through SQLite", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-task-flow-registry-e2e-",
      },
      async () => {
        resetFlowTestState();
        const now = Date.now();
        const oldTerminalAt = now - 8 * DAY_MS;

        const managed = requireManagedFlow({
          ownerKey: OWNER_KEY,
          controllerId: "qa/a08-flow-registry",
          goal: "Build a durable release report",
          status: "running",
          currentStep: "collect",
          stateJson: { completed: [] },
          createdAt: oldTerminalAt - MINUTE_MS,
          updatedAt: oldTerminalAt - MINUTE_MS,
        });
        const waiting = requireApplied(
          setFlowWaiting({
            flowId: managed.flowId,
            expectedRevision: managed.revision,
            currentStep: "review",
            stateJson: { completed: ["collect"] },
            waitJson: { kind: "approval", gate: "release" },
            updatedAt: oldTerminalAt - 30_000,
          }),
        );
        expect(waiting).toMatchObject({
          revision: 1,
          status: "waiting",
          currentStep: "review",
          waitJson: { kind: "approval", gate: "release" },
        });

        const staleWrite = resumeFlow({
          flowId: managed.flowId,
          expectedRevision: managed.revision,
          currentStep: "stale-write",
        });
        expect(staleWrite).toMatchObject({
          applied: false,
          reason: "revision_conflict",
          current: { revision: 1, status: "waiting" },
        });

        const resumed = requireApplied(
          resumeFlow({
            flowId: managed.flowId,
            expectedRevision: waiting.revision,
            status: "running",
            currentStep: "publish",
            stateJson: { completed: ["collect", "review"] },
            updatedAt: oldTerminalAt - 10_000,
          }),
        );
        const finished = requireApplied(
          finishFlow({
            flowId: managed.flowId,
            expectedRevision: resumed.revision,
            currentStep: "done",
            stateJson: { completed: ["collect", "review", "publish"] },
            updatedAt: oldTerminalAt,
            endedAt: oldTerminalAt,
          }),
        );
        expect(finished).toMatchObject({
          revision: 3,
          status: "succeeded",
          currentStep: "done",
        });

        const mirroredTask = requireTask({
          runtime: "subagent",
          ownerKey: OWNER_KEY,
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:a08",
          runId: "run-a08-mirrored",
          label: "Inspect release evidence",
          task: "Inspect release evidence",
          startedAt: now - 2 * MINUTE_MS,
          lastEventAt: now - 2 * MINUTE_MS,
          deliveryStatus: "pending",
        });
        const mirroredFlowId = mirroredTask.parentFlowId;
        if (!mirroredFlowId) {
          throw new Error("expected detached task to create a mirrored TaskFlow");
        }
        expect(getTaskFlowById(mirroredFlowId)).toMatchObject({
          syncMode: "task_mirrored",
          ownerKey: OWNER_KEY,
          status: "running",
          goal: "Inspect release evidence",
        });

        completeTaskRunByRunId({
          runId: "run-a08-mirrored",
          endedAt: now - MINUTE_MS,
          lastEventAt: now - MINUTE_MS,
          terminalSummary: "Evidence inspected.",
        });
        expect(getTaskFlowById(mirroredFlowId)).toMatchObject({
          syncMode: "task_mirrored",
          status: "succeeded",
          endedAt: now - MINUTE_MS,
        });

        const stuck = requireManagedFlow({
          ownerKey: OWNER_KEY,
          controllerId: "qa/a08-maintenance",
          goal: "Recover abandoned flow",
          status: "running",
          createdAt: now - 50 * MINUTE_MS,
          updatedAt: now - 40 * MINUTE_MS,
        });
        requireApplied(
          requestFlowCancel({
            flowId: stuck.flowId,
            expectedRevision: stuck.revision,
            cancelRequestedAt: now - 10 * MINUTE_MS,
            updatedAt: now - 40 * MINUTE_MS,
          }),
        );

        const cliFlow = requireManagedFlow({
          ownerKey: OWNER_KEY,
          controllerId: "qa/a08-cli",
          goal: "Cancel from the TaskFlow CLI",
          status: "running",
          createdAt: now - 5_000,
          updatedAt: now - 5_000,
        });

        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        reloadTaskRegistryFromStore();
        reloadTaskFlowRegistryFromStore();

        expect(
          getTaskFlowByIdForOwner({ flowId: managed.flowId, callerOwnerKey: OWNER_KEY }),
        ).toMatchObject({
          revision: 3,
          status: "succeeded",
          stateJson: { completed: ["collect", "review", "publish"] },
        });
        expect(
          getTaskFlowByIdForOwner({
            flowId: managed.flowId,
            callerOwnerKey: "agent:main:other",
          }),
        ).toBeUndefined();
        expect(listTaskFlowsForOwner({ callerOwnerKey: OWNER_KEY })).toHaveLength(4);
        expect(getTaskById(mirroredTask.taskId)).toMatchObject({
          parentFlowId: mirroredFlowId,
          status: "succeeded",
          terminalSummary: "Evidence inspected.",
        });

        const listRuntime = createRuntime();
        await flowsListCommand({ json: true }, listRuntime);
        expect(listRuntime.error).not.toHaveBeenCalled();
        expect(listRuntime.writeJson.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            count: 4,
            flows: expect.arrayContaining([
              expect.objectContaining({
                flowId: managed.flowId,
                syncMode: "managed",
                status: "succeeded",
              }),
              expect.objectContaining({
                flowId: mirroredFlowId,
                syncMode: "task_mirrored",
                status: "succeeded",
                taskSummary: expect.objectContaining({ total: 1, terminal: 1 }),
              }),
            ]),
          }),
        );

        const showRuntime = createRuntime();
        await flowsShowCommand({ lookup: mirroredFlowId, json: true }, showRuntime);
        expect(showRuntime.error).not.toHaveBeenCalled();
        expect(showRuntime.writeJson.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            flowId: mirroredFlowId,
            syncMode: "task_mirrored",
            tasks: [expect.objectContaining({ taskId: mirroredTask.taskId })],
          }),
        );

        const cancelRuntime = createRuntime();
        await flowsCancelCommand({ lookup: cliFlow.flowId }, cancelRuntime);
        expect(cancelRuntime.error).not.toHaveBeenCalled();
        expect(cancelRuntime.exit).not.toHaveBeenCalled();
        expect(getTaskFlowById(cliFlow.flowId)).toMatchObject({
          status: "cancelled",
          cancelRequestedAt: expect.any(Number),
          endedAt: expect.any(Number),
        });

        const findings = listTaskFlowAuditFindings({ now });
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "stale_running",
              flow: expect.objectContaining({ flowId: stuck.flowId }),
            }),
            expect.objectContaining({
              code: "missing_linked_tasks",
              flow: expect.objectContaining({ flowId: stuck.flowId }),
            }),
            expect.objectContaining({
              code: "cancel_stuck",
              flow: expect.objectContaining({ flowId: stuck.flowId }),
            }),
          ]),
        );
        expect(previewTaskFlowRegistryMaintenance()).toEqual({
          reconciled: 1,
          pruned: 1,
        });
        expect(await runTaskFlowRegistryMaintenance()).toEqual({
          reconciled: 1,
          pruned: 1,
        });
        expect(getTaskFlowById(stuck.flowId)).toMatchObject({
          status: "cancelled",
          endedAt: expect.any(Number),
        });
        expect(getTaskFlowById(managed.flowId)).toBeUndefined();
        expect(getTaskFlowById(mirroredFlowId)).toMatchObject({
          status: "succeeded",
          syncMode: "task_mirrored",
        });
      },
    );
  });
});
