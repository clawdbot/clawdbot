/**
 * Fanout error isolation.
 *
 * If one delegate in a fanout batch errors mid-dispatch, sibling delegates
 * are NOT aborted. The parent (dispatch loop) collects partial results:
 * dispatched count + rejected count + per-delegate TaskFlow status
 * (succeeded / failed). Each delegate is spawned independently via
 * `spawnSubagentDirect` and a single failure does NOT short-circuit the loop.
 *
 * This test extends the existing coverage in delegate-dispatch.test.ts
 * ("marks rejected/thrown delegates failed without aborting later delegates")
 * to the targeted fanout shape: each delegate targets a DIFFERENT session via
 * `targetSessionKey`, and a mid-batch failure does not affect siblings.
 *
 * Mock infrastructure mirrors delegate-dispatch.test.ts to keep TaskFlow,
 * subagent-spawn, system-events, and subsystem logger all stubbed.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock infrastructure — copied from delegate-dispatch.test.ts so this file
// is self-contained and survives independent refactors of the original.
// ---------------------------------------------------------------------------

const mockFlows = new Map<string, Record<string, unknown>>();
const enqueueSystemEventMock = vi.fn();
const loggerRecords: Array<{ level: string; message: string }> = [];
const spawnSubagentDirectMock = vi.fn();
let flowIdCounter = 0;

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getSubagentRunByChildSessionKey: () => null,
  hasLiveContinuationDelegateChildRun: () => false,
  isSubagentRunLive: () => false,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options: unknown) => enqueueSystemEventMock(text, options),
}));

vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

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
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) => {
    return [...mockFlows.values()].filter((f) => f.ownerKey === ownerKey);
  }),
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
  failFlow: vi.fn((params: { flowId: string }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { resetContinuationTracer } from "../../infra/continuation-tracer.js";
import { dispatchToolDelegates, resetDelegateDispatchHedgesForTests } from "./delegate-dispatch.js";
import { enqueuePendingDelegate } from "./delegate-store.js";
import { resetContinuationStateForTests } from "./state.js";

beforeEach(() => {
  mockFlows.clear();
  enqueueSystemEventMock.mockClear();
  loggerRecords.length = 0;
  spawnSubagentDirectMock.mockReset().mockResolvedValue({ status: "accepted" });
  flowIdCounter = 0;
});

afterEach(() => {
  resetDelegateDispatchHedgesForTests();
  resetContinuationStateForTests();
  resetContinuationTracer();
  clearRuntimeConfigSnapshot();
  mockFlows.clear();
});

describe("fanout error isolation", () => {
  it("three delegates targeting different sessions: middle one fails, first and third still dispatch", async () => {
    const sessionKey = "session-fanout-isolation";

    // Each delegate fans out to a DIFFERENT target session via targetSessionKey:
    // one tool turn, N delegates, each with an independent target.
    enqueuePendingDelegate(sessionKey, {
      task: "fanout-target-A",
      targetSessionKey: "channel:target-A",
    });
    enqueuePendingDelegate(sessionKey, {
      task: "fanout-target-B",
      targetSessionKey: "channel:target-B",
    });
    enqueuePendingDelegate(sessionKey, {
      task: "fanout-target-C",
      targetSessionKey: "channel:target-C",
    });

    // The MIDDLE delegate's spawn rejects mid-fanout. First and third succeed.
    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "accepted" })
      .mockRejectedValueOnce(new Error("session-B delivery failure"))
      .mockResolvedValueOnce({ status: "accepted" });

    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === sessionKey && f.status === "queued")
      .map((f) => f.flowId as string);
    expect(queuedBefore).toHaveLength(3);

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
      config: {
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
      },
    });

    // PARTIAL RESULTS: parent collected 2 successes + 1 failure.
    // The middle failure did NOT abort the third delegate.
    expect(result.dispatched).toBe(2);
    expect(result.rejected).toBe(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(3);

    // Per-delegate TaskFlow status is recorded independently.
    expect(mockFlows.get(expectDefined(queuedBefore.at(0), "first flow id"))?.status).toBe(
      "succeeded",
    );
    expect(mockFlows.get(expectDefined(queuedBefore.at(1), "second flow id"))?.status).toBe(
      "failed",
    );
    expect(mockFlows.get(expectDefined(queuedBefore.at(2), "third flow id"))?.status).toBe(
      "succeeded",
    );

    // The targetSessionKey was preserved end-to-end for the surviving siblings —
    // proves the third delegate's fanout target was NOT clobbered by the
    // middle delegate's failure path.
    const spawnParams = spawnSubagentDirectMock.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(spawnParams[0]).toMatchObject({ task: expect.stringContaining("fanout-target-A") });
    expect(spawnParams[2]).toMatchObject({ task: expect.stringContaining("fanout-target-C") });

    // The failure was surfaced as a system event for the originating session,
    // but only for the failing delegate — siblings did NOT generate noise.
    const failureEvents = enqueueSystemEventMock.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("DELEGATE spawn failed: session-B delivery failure"),
    );
    expect(failureEvents).toHaveLength(1);
  });

  it("first delegate fails: subsequent siblings are NOT short-circuited", async () => {
    // Inverse-position variant: failure at the HEAD of the fanout still
    // permits all tail siblings to dispatch. Pins that the dispatch loop
    // has no "stop on first error" path.
    const sessionKey = "session-fanout-head-failure";

    enqueuePendingDelegate(sessionKey, {
      task: "head-fails",
      targetSessionKey: "channel:head",
    });
    enqueuePendingDelegate(sessionKey, {
      task: "tail-1",
      targetSessionKey: "channel:tail-1",
    });
    enqueuePendingDelegate(sessionKey, {
      task: "tail-2",
      targetSessionKey: "channel:tail-2",
    });

    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "forbidden" })
      .mockResolvedValueOnce({ status: "accepted" })
      .mockResolvedValueOnce({ status: "accepted" });

    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === sessionKey && f.status === "queued")
      .map((f) => f.flowId as string);

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
      config: {
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
      },
    });

    expect(result.dispatched).toBe(2);
    expect(result.rejected).toBe(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(3);
    expect(mockFlows.get(expectDefined(queuedBefore.at(0), "first flow id"))?.status).toBe(
      "failed",
    );
    expect(mockFlows.get(expectDefined(queuedBefore.at(1), "second flow id"))?.status).toBe(
      "succeeded",
    );
    expect(mockFlows.get(expectDefined(queuedBefore.at(2), "third flow id"))?.status).toBe(
      "succeeded",
    );
  });
});
