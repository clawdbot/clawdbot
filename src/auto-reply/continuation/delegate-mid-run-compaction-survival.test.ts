/**
 * Review Q2 (extension) — mid-run delegates survive
 * parent compaction.
 *
 * For delegates that were already DISPATCHED in prior turns (now executing
 * in independent child sessions), parent-session compaction does NOT touch
 * them. The contract is enforced by what `releasePostCompactionLifecycle`
 * is allowed to observe: it ONLY consumes the STAGED post-compaction bag
 * (`claimStagedPostCompactionTaskFlowDelegates`). It does NOT enumerate live
 * children, does NOT call kill/abort/terminate, does NOT scan a sessions
 * registry. Children run independently to completion and deliver via
 * session-delivery-queue when they finish.
 *
 * This is a contract test for that boundary: we mock the lifecycle helper's
 * dependencies, hand it exactly 2 staged delegates, and verify the ONLY
 * outbound action against any session is dispatching those 2 — no extra
 * spawn, no kill, no abort, no termination, no probe of any other session.
 *
 * Mock layout mirrors post-compaction-release.test.ts so this file sits
 * alongside the existing helper test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releasePostCompactionLifecycle } from "./post-compaction-release.js";

const mockState = vi.hoisted(() => ({
  assertStagedPostCompactionFinalizationComplete: vi.fn(
    (params: { flowIds: readonly (string | undefined)[]; finalized: number }) => {
      const expected = params.flowIds.filter(Boolean).length;
      if (params.finalized !== expected) {
        throw new Error(`finalized ${params.finalized}/${expected}`);
      }
    },
  ),
  claimStagedPostCompactionTaskFlowDelegates: vi.fn(),
  finalizeStagedPostCompactionDelegates: vi.fn(),
  clearContextPressureState: vi.fn(),
  checkContextPressure: vi.fn(),
  spawnSubagentDirect: vi.fn(),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./lazy.runtime.js", () => ({
  assertStagedPostCompactionFinalizationComplete:
    mockState.assertStagedPostCompactionFinalizationComplete,
  claimStagedPostCompactionTaskFlowDelegates: mockState.claimStagedPostCompactionTaskFlowDelegates,
  finalizeStagedPostCompactionDelegates: mockState.finalizeStagedPostCompactionDelegates,
  clearContextPressureState: mockState.clearContextPressureState,
  checkContextPressure: mockState.checkContextPressure,
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: mockState.spawnSubagentDirect,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mockState.enqueueSystemEvent,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./config.js", () => ({
  resolveContinuationRuntimeConfig: () => ({
    enabled: true,
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    crossSessionTargeting: "enabled",
    contextPressureThreshold: 0.8,
  }),
}));

const SESSION_KEY = "channel:parent-undergoing-compaction";

const ORIGINATING = {
  originatingChannel: "discord",
  originatingAccountId: "default",
  originatingTo: "channel:X",
  originatingThreadId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState.finalizeStagedPostCompactionDelegates.mockImplementation(
    (flowIds: readonly (string | undefined)[]) => flowIds.filter(Boolean).length,
  );
  mockState.spawnSubagentDirect.mockResolvedValue({ status: "accepted" });
});

describe("mid-run delegate survival under parent compaction (Q2 extension)", () => {
  it("releasePostCompactionLifecycle ONLY touches staged delegates — no enumeration, kill, or abort of other sessions", async () => {
    // Two delegates were staged via continue_delegate(mode="post-compaction")
    // during the prior turn. They are what the lifecycle release MUST dispatch.
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([
      { task: "rehydrate-from-stage-A" },
      { task: "rehydrate-from-stage-B" },
    ]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    // (1) Consume was called exactly ONCE for the parent session — the
    //     helper drains the staged bag and is done. It does NOT iterate or
    //     enumerate other sessions.
    expect(mockState.claimStagedPostCompactionTaskFlowDelegates).toHaveBeenCalledTimes(1);
    expect(mockState.claimStagedPostCompactionTaskFlowDelegates).toHaveBeenCalledWith(SESSION_KEY);

    // (2) Exactly 2 spawns happened — one per staged delegate. The lifecycle
    //     release did NOT spawn anything extra (no "kill", no "abort", no
    //     "terminate", no probe of running children).
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(2);
    const spawnTasks = mockState.spawnSubagentDirect.mock.calls.map(
      (call) => (call[0] as { task: string }).task,
    );
    expect(spawnTasks).toEqual([
      expect.stringContaining("rehydrate-from-stage-A"),
      expect.stringContaining("rehydrate-from-stage-B"),
    ]);
    expect(spawnTasks[0]).toContain("[continuation:chain-hop:1]");
    expect(spawnTasks[1]).toContain("[continuation:chain-hop:2]");

    // (3) Each dispatch carries the canonical post-compaction flag set.
    for (const call of mockState.spawnSubagentDirect.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
        }),
      );
    }

    expect(result.delegatesDispatched).toBe(2);
  });

  it("zero staged delegates: lifecycle release dispatches nothing — proves mid-run children are not enumerated", async () => {
    // The previous turn dispatched several normal `continue_delegate` calls
    // (no mode="post-compaction"). Those delegates are now running in their
    // own child sessions. NONE of them are staged in the post-compaction
    // bag. When compaction fires:
    //
    //   - The staged bag is empty (consume returns []).
    //   - releasePostCompactionLifecycle dispatches ZERO spawns.
    //   - The mid-run children are completely untouched — they keep running
    //     in their own sessions and deliver back via session-delivery-queue
    //     whenever they complete.
    //
    // This pins the contract: the only outbound action against any session
    // is what the staged bag tells us to dispatch. Mid-run delegates are
    // invisible to this code path.
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    expect(mockState.claimStagedPostCompactionTaskFlowDelegates).toHaveBeenCalledTimes(1);
    expect(mockState.claimStagedPostCompactionTaskFlowDelegates).toHaveBeenCalledWith(SESSION_KEY);

    // ZERO spawns. The lifecycle release did not "find" any mid-run delegates
    // to terminate or restart, because the code path has no awareness of them.
    expect(mockState.spawnSubagentDirect).not.toHaveBeenCalled();

    expect(result.delegatesDispatched).toBe(0);
  });

  it("staged delegates are not retried on second release call — consume drains once, mid-run siblings still untouched", async () => {
    // First release: 1 staged delegate, dispatched.
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates
      .mockReturnValueOnce([{ task: "rehydrate-once" }])
      .mockReturnValueOnce([]); // store is drained on second consume

    const first = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });
    expect(first.delegatesDispatched).toBe(1);
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(1);

    // Second release call (defensive retry simulation): consume returns []
    // because store was drained. No second dispatch — and STILL no attempt
    // to enumerate or terminate any mid-run child session.
    const second = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });
    expect(second.delegatesDispatched).toBe(0);
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(1); // still 1, not 2
  });
});
