// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Real-store proof for the accepted post-compaction chain-charge marker
 * (karmaterminal/openclaw#1198).
 *
 * The queued-delivery suites inject this operation, so these tests run it
 * against the TaskFlow-backed delegate store to pin the two facts delivery
 * depends on: the marker write advances the row revision (acceptance must
 * commit against the new one), and a row that already carries an `advanced`
 * marker returns that same hop forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";

type MockTaskFlowRecord = {
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

const mockFlows = new Map<string, MockTaskFlowRecord>();
let flowIdCounter = 0;

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn(
    (params: {
      ownerKey: string;
      controllerId: string;
      stateJson: unknown;
      goal: string;
      currentStep: string;
    }) => {
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
    },
  ),
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
      updatedAt?: number;
      endedAt?: number;
      stateJson?: unknown;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string; expectedRevision: number; stateJson?: unknown }) => {
    const flow = mockFlows.get(params.flowId);
    if (!flow || flow.revision !== params.expectedRevision) {
      return {
        applied: false,
        reason: flow ? "revision_conflict" : "not_found",
        current: flow ? { ...flow } : undefined,
      };
    }
    flow.status = "failed";
    if (params.stateJson !== undefined) {
      flow.stateJson = params.stateJson;
    }
    flow.revision = flow.revision + 1;
    return { applied: true };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import {
  claimStagedPostCompactionTaskFlowDelegates,
  markPendingDelegateSpawnAccepted,
  stagePostCompactionTaskFlowDelegate,
} from "./delegate-store.js";
import { reserveAcceptedPostCompactionChainHop } from "./post-compaction-chain-charge.js";
import type { ChainState } from "./types.js";

const SESSION_KEY = "channel:session-1198";

function plannedHop(count: number): ChainState {
  return {
    currentChainCount: count,
    chainStartedAt: 1_700_000_000_000,
    accumulatedChainTokens: 0,
    chainId: `chain-${count}`,
  };
}

function claimOneStagedDelegate() {
  stagePostCompactionTaskFlowDelegate(SESSION_KEY, {
    task: "carry working state",
    stagedAt: Date.now(),
    firstArmedAt: Date.now(),
  });
  const claimed = claimStagedPostCompactionTaskFlowDelegates(SESSION_KEY);
  const delegate = claimed[0];
  if (!delegate?.flowId || delegate.expectedRevision === undefined) {
    throw new Error("expected a claimed post-compaction delegate");
  }
  return delegate;
}

beforeEach(() => {
  setRuntimeConfigSnapshot({
    tools: { sessions_spawn: { attachments: { enabled: true } } },
  });
  mockFlows.clear();
  flowIdCounter = 0;
});

afterEach(() => {
  mockFlows.clear();
});

describe("reserveAcceptedPostCompactionChainHop", () => {
  it("records the planned hop and returns the advanced revision acceptance must use", () => {
    const delegate = claimOneStagedDelegate();
    const claimedRevision = delegate.expectedRevision!;

    const reserved = reserveAcceptedPostCompactionChainHop(delegate, plannedHop(3));

    expect(reserved.chainState).toMatchObject({ currentChainCount: 3, chainId: "chain-3" });
    expect(reserved.expectedRevision).toBe(claimedRevision + 1);
    // Acceptance commits against the post-marker revision; the stale claim
    // revision would be rejected by the revision fence.
    expect(
      markPendingDelegateSpawnAccepted(
        { ...delegate, expectedRevision: reserved.expectedRevision },
        "agent:main:subagent:continuation-child",
      ),
    ).toBe(true);
  });

  it("returns the same hop on replay instead of advancing continuation depth again", () => {
    const delegate = claimOneStagedDelegate();

    const first = reserveAcceptedPostCompactionChainHop(delegate, plannedHop(3));
    // A replayed delivery re-reads the row and plans the next hop from a session
    // entry that may already have been advanced; the marker wins.
    const replay = reserveAcceptedPostCompactionChainHop(delegate, plannedHop(4));

    expect(replay.chainState).toEqual(first.chainState);
    expect(replay.chainState.currentChainCount).toBe(3);
    expect(replay.expectedRevision).toBe(first.expectedRevision);
  });

  it("passes the planned hop straight through when the entry has no source row", () => {
    const reserved = reserveAcceptedPostCompactionChainHop(
      { task: "sourceless queued delegate" },
      plannedHop(1),
    );

    expect(reserved.chainState).toMatchObject({ currentChainCount: 1 });
    expect(reserved.expectedRevision).toBeUndefined();
  });
});
