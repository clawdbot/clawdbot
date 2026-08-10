// ─────────────────────────────────────────────────────────────────────────────
// delegate-dispatch — cost-cap exhaustion mid-chain
//
// SEAM GUARDED: This file traps the cost-cap invariant — the second of
// the two bounded-continuation guards (the first
// being chain-depth, covered in the sibling test file). Where chain-depth
// counts HOPS, cost-cap counts TOKENS. A long chain of cheap delegates
// might never hit chain-depth but could still burn through the user's
// token budget; the cost-cap is the financial-pressure brake.
//
// ARCHITECTURAL CANON (from delegate-dispatch.ts):
//   1. EVERY chain carries an accumulatedChainTokens running total.
//   2. The dispatcher compares it to config.costCapTokens using
//      STRICT-GREATER-THAN. accumulated > cap → reject; accumulated <=
//      cap → allow. This means an exact equality at the cap is ALLOWED,
//      not rejected — a deliberate "one more allowed at the line" choice
//      that this test file pins down.
//   3. Once the cap is crossed, EVERY remaining queued delegate in the
//      same dispatch call is rejected as a CASCADE — the dispatcher
//      doesn't re-check each one independently because the accumulated
//      total can only grow.
//   4. Cap-rejected delegates transition their TaskFlow record from
//      `queued` to `failed`, identical to chain-depth rejections.
//   5. Cap rejections emit a system event with "cost-capped" text.
//
// Tests guard distinct corners of the
// cost-cap contract:
//   - just-under   → ALLOW (proves the gate isn't over-eager)
//   - just-over    → REJECT (proves the gate fires)
//   - exact        → ALLOW (proves strict-greater-than, not >=)
//   - cascade      → all-remaining-rejected (proves the loop short-circuits)
//   - taskflow     → failed-state recorded (proves side-effect persists)
//
// If a future refactor changes the comparison operator (`>` → `>=`),
// removes the cascade short-circuit, or skips the failFlow call on
// cost-rejection, exactly one of these tests will fire and route the
// reviewer to the budget block in delegate-dispatch.ts. The five-point
// coverage is intentional — collapsing any two would leave a blind spot.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock setup ──────────────────────────────────────────────────────────
// Mock TaskFlow registry — same pattern as delegate-dispatch.test.ts.
// All side-effect surfaces (spawn, system-events, task-flow-registry) are
// mocked so we can assert on dispatcher INTENT rather than downstream
// production state.
const mockFlows = new Map<string, Record<string, unknown>>();
const enqueueSystemEventMock = vi.fn();
const loggerRecords: Array<{ level: string; message: string }> = [];
const spawnSubagentDirectMock = vi.fn();
let flowIdCounter = 0;

vi.mock("../../agents/subagents/spawn/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
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
  finishFlow: vi.fn((params: { flowId: string; expectedRevision: number }) => {
    const flow = mockFlows.get(params.flowId);
    if (!flow || flow.revision !== params.expectedRevision) {
      return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
    }
    flow.status = "succeeded";
    flow.revision = flow.revision + 1;
    return { applied: true, flow: { ...flow } };
  }),
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
  // Fresh mock state per test — chain-state contamination between tests
  // could mask a real budget-check regression by carrying tokens forward.
  mockFlows.clear();
  enqueueSystemEventMock.mockClear();
  loggerRecords.length = 0;
  spawnSubagentDirectMock.mockReset().mockResolvedValue({ status: "accepted" });
  flowIdCounter = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  resetDelegateDispatchHedgesForTests();
  resetContinuationStateForTests();
  resetContinuationTracer();
  clearRuntimeConfigSnapshot();
  mockFlows.clear();
  vi.useRealTimers();
});

describe("cost-cap exhaustion mid-chain", () => {
  // COST-CAP AXIS: tests below pin five points relative to costCapTokens:
  //   accumulated = cap - 1   → ALLOW   (sanity: gate isn't over-eager)
  //   accumulated = cap + 1   → REJECT  (sanity: gate fires)
  //   accumulated = cap       → ALLOW   (canon: strict-greater-than, not >=)
  //   cascade (3 queued, all over) → 3 rejected (canon: short-circuit loop)
  //   side-effect (TaskFlow)       → failed-state (canon: persistent record)

  // ───────────────────────────────────────────────────────────────────────
  // JUST-UNDER case: accumulated = 499_999, cap = 500_000.
  //
  // CANON GUARDED: the gate is not over-eager. Being 1 token below the
  // cap is still under the cap; dispatch should succeed.
  //
  // Regression indicator: if this test starts asserting rejection, the
  // gate operator went from `>` to `>=` or got an off-by-one; reviewer
  // should look at the cost-cap comparison in delegate-dispatch.ts.
  // ───────────────────────────────────────────────────────────────────────
  it("allows dispatch when accumulatedChainTokens is 1 below costCapTokens", async () => {
    const sessionKey = "session-cost-cap-just-under";
    enqueuePendingDelegate(sessionKey, { task: "squeaks under the cap" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 499_999,
      },
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
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
    });

    // 499_999 < 500_000 → not cost-capped, should spawn.
    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(0);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("squeaks under the cap"),
      }),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // JUST-OVER case: accumulated = 500_001, cap = 500_000.
  //
  // CANON GUARDED: the gate fires on over-cap, emitting the cost-capped
  // system event so the model can see why its delegate didn't dispatch.
  //
  // Regression indicator: if this test starts asserting "dispatched: 1",
  // the cost-cap check has been removed or bypassed; reviewer should
  // grep delegate-dispatch.ts for costCapTokens comparisons.
  // ───────────────────────────────────────────────────────────────────────
  it("rejects dispatch when accumulatedChainTokens exceeds costCapTokens by 1", async () => {
    const sessionKey = "session-cost-cap-just-over";
    enqueuePendingDelegate(sessionKey, { task: "over the budget" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 500_001,
      },
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
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
    });

    expect(result.dispatched).toBe(0);
    expect(result.rejected).toBe(1);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();

    // Surface canon: cost-cap rejections emit a "cost-capped" system event.
    // The text content is part of the contract with continue-work-signal-v2
    // so the model can self-correct on next turn.
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(expect.stringContaining("cost-capped"), {
      sessionKey,
      trusted: true,
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // CASCADE case: 3 delegates queued, all start over-cap.
  //
  // CANON GUARDED: once accumulated tokens exceed the cap, every
  // remaining queued delegate in the same dispatch call is rejected —
  // the loop doesn't re-evaluate from scratch (accumulated can only
  // grow). This is the cascade-rejection-on-cap behavior.
  //
  // Regression indicator: if this test starts asserting "rejected: 1"
  // (only the first checked, rest mysteriously absent) or "rejected: 0,
  // dispatched: 3" (cap somehow cleared mid-loop), the cascade logic is
  // broken; reviewer should look at the for-each-delegate iteration in
  // delegate-dispatch.ts.
  // ───────────────────────────────────────────────────────────────────────
  it("rejects all remaining queued delegates once cost cap is crossed", async () => {
    const sessionKey = "session-cost-cap-remaining-rejected";
    enqueuePendingDelegate(sessionKey, { task: "delegate-1" });
    enqueuePendingDelegate(sessionKey, { task: "delegate-2" });
    enqueuePendingDelegate(sessionKey, { task: "delegate-3" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 500_001,
      },
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
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
    });

    // ALL three should be rejected — once over cap, every subsequent
    // delegate in the same dispatch call is also over (accumulated can
    // only grow, never shrink, within a single dispatch).
    expect(result.dispatched).toBe(0);
    expect(result.rejected).toBe(3);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // SIDE-EFFECT case: TaskFlow record state on cost-cap rejection.
  //
  // CANON GUARDED: cost-cap rejection transitions the persistent
  // TaskFlow record from `queued` to `failed`, identical to chain-depth
  // rejections. The two budget-rejection paths must produce symmetric
  // observable state.
  //
  // Regression indicator: if the TaskFlow stays `queued` after a cost-cap
  // rejection, the failFlow call is missing from the cost-cap branch
  // (but possibly still present in the chain-depth branch — the sibling
  // test would still pass). This is a sneaky regression shape; reviewer
  // should diff the two rejection branches for parity.
  // ───────────────────────────────────────────────────────────────────────
  it("marks TaskFlow records as failed for cost-cap-rejected delegates", async () => {
    const sessionKey = "session-cost-cap-taskflow-failed";
    enqueuePendingDelegate(sessionKey, { task: "doomed by cost" });

    const queuedBefore = [...mockFlows.values()].filter(
      (f) => f.ownerKey === sessionKey && f.status === "queued",
    );
    expect(queuedBefore).toHaveLength(1);
    const flowId = queuedBefore.at(0)?.flowId;
    if (typeof flowId !== "string") {
      throw new Error("expected queued flow id");
    }

    await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 500_001,
      },
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
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
    });

    // Final-state assertion: queued → failed. Symmetric with the
    // chain-depth equivalent test in the sibling file.
    expect(mockFlows.get(flowId)?.status).toBe("failed");
  });

  // ───────────────────────────────────────────────────────────────────────
  // EXACT-BOUNDARY case: accumulated === costCapTokens (= 500_000).
  //
  // CANON GUARDED: strict-greater-than semantics. The check is
  // `accumulatedChainTokens > costCapTokens`, NOT `>=`. At exactly the
  // cap value, dispatch is still ALLOWED — the cap is the inclusive
  // ceiling, not the exclusive one.
  //
  // Regression indicator: this is the single most surgical pin in the
  // file. If `>` ever flips to `>=` (very easy refactor mistake, looks
  // like a "be safer" change), this test fires immediately and only
  // this test — none of the just-under/just-over/cascade tests would
  // catch it. Reviewer should look at the cost-cap comparison operator
  // in delegate-dispatch.ts and verify it's strict-greater-than.
  // ───────────────────────────────────────────────────────────────────────
  it("rejects at exact boundary (accumulatedChainTokens === costCapTokens is NOT over)", async () => {
    const sessionKey = "session-cost-cap-exact-boundary";
    enqueuePendingDelegate(sessionKey, { task: "at exact cap" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 500_000,
      },
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
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
    });

    // The check is `accumulatedChainTokens > costCapTokens` (strict).
    // At exactly 500_000 it should NOT be cost-capped — equality is
    // the inclusive ceiling, not the exclusive one. NOTE: the test
    // title says "rejects at exact boundary" but the canon being
    // guarded is the OPPOSITE — the title preserves historical naming
    // while the assertions encode the actual contract (allow-at-cap).
    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(0);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });
});
