import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFlows = new Map<string, Record<string, unknown>>();
const spawnSubagentDirectMock = vi.fn();
const acceptedChildSessionKeys = new Set<string>();
let flowIdCounter = 0;

vi.mock("../../agents/subagents/spawn/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSubagentRunByChildSessionKey: () => null,
  hasLiveContinuationDelegateChildRun: (params: { childSessionKey: string }) =>
    acceptedChildSessionKeys.has(params.childSessionKey),
  isSubagentRunLive: () => false,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: () => undefined,
  updateSessionEntry: vi.fn(async () => null),
}));

vi.mock("../../infra/session-delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/session-delivery-queue-storage.js")>()),
  loadPendingSessionDeliveries: vi.fn(async () => []),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEventRaw: vi.fn(),
}));

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn((params: Record<string, unknown>) => {
    const flowId = `flow-${++flowIdCounter}`;
    mockFlows.set(flowId, {
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
    return mockFlows.get(flowId);
  }),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    [...mockFlows.values()].filter((flow) => flow.ownerKey === ownerKey),
  ),
  listTaskFlowRecords: vi.fn(() => [...mockFlows.values()]),
  getTaskFlowById: vi.fn((flowId: string) => mockFlows.get(flowId)),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      Object.assign(flow, params.patch);
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string; stateJson?: unknown }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
      flow.stateJson = params.stateJson ?? flow.stateJson;
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import {
  abortContinuationDispatchClaims,
  resetContinuationDispatchClaimsForTests,
} from "./continuation-dispatch-claims.js";
import { recoverPendingContinuationDelegates } from "./delegate-dispatch-recovery.js";
import { dispatchToolDelegates, resetDelegateDispatchHedgesForTests } from "./delegate-dispatch.js";
import { enqueuePendingDelegate } from "./delegate-store.js";
import { cancelSessionContinuations } from "./session-reset.js";
import type { ContinuationRuntimeConfig } from "./types.js";

function continuationConfig(): ContinuationRuntimeConfig {
  return {
    enabled: true,
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    maxPendingWork: 32,
    crossSessionTargeting: "enabled",
    earlyWarningBand: 0.3125,
  };
}

beforeEach(() => {
  mockFlows.clear();
  acceptedChildSessionKeys.clear();
  flowIdCounter = 0;
  spawnSubagentDirectMock.mockReset().mockResolvedValue({ status: "accepted" });
});

afterEach(() => {
  resetContinuationDispatchClaimsForTests();
  resetDelegateDispatchHedgesForTests();
  mockFlows.clear();
  acceptedChildSessionKeys.clear();
});

describe("delegate dispatch admission reset race", () => {
  it("closes post-fence delegate admission when reset durably cancels the source", async () => {
    const sessionKey = "agent:main:delegate-reset-after-fence";
    const delegate = enqueuePendingDelegate(sessionKey, { task: "must not spawn after reset" });
    if (!delegate) {
      throw new Error("expected durable delegate");
    }
    let releaseSpawn!: () => void;
    let spawnReached!: () => void;
    const reachedSpawn = new Promise<void>((resolve) => {
      spawnReached = resolve;
    });
    const spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    spawnSubagentDirectMock.mockImplementationOnce(
      async (
        _params,
        context: {
          continuationDelegateAdmission: {
            assertCurrent(boundary: "child-session"): void;
          };
        },
      ) => {
        spawnReached();
        await spawnBarrier;
        context.continuationDelegateAdmission.assertCurrent("child-session");
        return { status: "accepted", childSessionKey: "unexpected-child" };
      },
    );

    const dispatch = dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      ctx: { sessionKey },
      maxChainLength: 8,
      config: continuationConfig(),
    });
    await reachedSpawn;
    cancelSessionContinuations(sessionKey);
    abortContinuationDispatchClaims(sessionKey);
    releaseSpawn();

    await expect(dispatch).resolves.toMatchObject({ dispatched: 0, rejected: 1 });
    expect(mockFlows.get(delegate.flowId!)?.status).toBe("cancelled");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(acceptedChildSessionKeys.size).toBe(0);

    await recoverPendingContinuationDelegates();
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(mockFlows.get(delegate.flowId!)?.status).toBe("cancelled");
  });
});
