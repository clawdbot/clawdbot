/**
 * In-memory TaskFlow registry double for continuation delegate-store tests.
 *
 * `vi.mock` factories are hoisted above imports, so consume this through a
 * dynamic import inside the factory:
 *
 * ```ts
 * vi.mock("../../tasks/task-flow-registry.js", async () => {
 *   const harness = await import("./delegate-taskflow-registry.test-harness.js");
 *   return harness.createTaskFlowRegistryMock();
 * });
 * ```
 *
 * It models the one behavior these suites depend on: every applied write is
 * revision-fenced and bumps `revision` by one, mirroring
 * `task-flow-registry.ts` `updateFlowRecordByIdExpectedRevision`.
 */
import { vi } from "vitest";

export type MockTaskFlowRecord = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  controllerId: string;
  status: string;
  stateJson: unknown;
  goal: string;
  currentStep: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  cancelRequestedAt?: number;
};

export const mockTaskFlows = new Map<string, MockTaskFlowRecord>();
let flowIdCounter = 0;

export function resetMockTaskFlows(): void {
  mockTaskFlows.clear();
  flowIdCounter = 0;
}

function conflict(flow: MockTaskFlowRecord | undefined) {
  return {
    applied: false,
    reason: flow ? "revision_conflict" : "not_found",
    current: flow ? { ...flow } : undefined,
  };
}

export function createTaskFlowRegistryMock() {
  return {
    createManagedTaskFlow: vi.fn(
      (params: {
        ownerKey: string;
        controllerId: string;
        stateJson: unknown;
        goal: string;
        currentStep: string;
      }) => {
        const flowId = `flow-${++flowIdCounter}`;
        mockTaskFlows.set(flowId, {
          flowId,
          syncMode: "managed",
          ownerKey: params.ownerKey,
          controllerId: params.controllerId,
          status: "queued",
          stateJson: params.stateJson,
          goal: params.goal,
          currentStep: params.currentStep,
          revision: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return mockTaskFlows.get(flowId);
      },
    ),
    listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
      [...mockTaskFlows.values()].filter((flow) => flow.ownerKey === ownerKey),
    ),
    listTaskFlowRecords: vi.fn(() => [...mockTaskFlows.values()]),
    getTaskFlowById: vi.fn((flowId: string) => mockTaskFlows.get(flowId)),
    updateFlowRecordByIdExpectedRevision: vi.fn(
      (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
        const flow = mockTaskFlows.get(params.flowId);
        if (!flow || flow.revision !== params.expectedRevision) {
          return conflict(flow);
        }
        Object.assign(flow, params.patch);
        flow.revision += 1;
        return { applied: true, flow: { ...flow } };
      },
    ),
    finishFlow: vi.fn(
      (params: {
        flowId: string;
        expectedRevision: number;
        updatedAt?: number;
        endedAt?: number;
        currentStep?: string;
        stateJson?: unknown;
      }) => {
        const flow = mockTaskFlows.get(params.flowId);
        if (!flow || flow.revision !== params.expectedRevision) {
          return conflict(flow);
        }
        flow.status = "succeeded";
        flow.stateJson = params.stateJson ?? flow.stateJson;
        flow.currentStep = params.currentStep ?? flow.currentStep;
        flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
        flow.updatedAt = params.updatedAt ?? flow.endedAt;
        flow.revision += 1;
        return { applied: true, flow: { ...flow } };
      },
    ),
    failFlow: vi.fn(
      (params: {
        flowId: string;
        expectedRevision: number;
        stateJson?: unknown;
        currentStep?: string;
        blockedSummary?: string;
        updatedAt?: number;
        endedAt?: number;
      }) => {
        const flow = mockTaskFlows.get(params.flowId);
        if (!flow || flow.revision !== params.expectedRevision) {
          return conflict(flow);
        }
        flow.status = "failed";
        if (params.stateJson !== undefined) {
          flow.stateJson = params.stateJson;
        }
        flow.currentStep = params.currentStep ?? flow.currentStep;
        flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
        flow.updatedAt = params.updatedAt ?? flow.endedAt;
        flow.revision += 1;
        return { applied: true, flow: { ...flow } };
      },
    ),
    deleteTaskFlowRecordById: vi.fn((flowId: string) => {
      mockTaskFlows.delete(flowId);
    }),
  };
}
