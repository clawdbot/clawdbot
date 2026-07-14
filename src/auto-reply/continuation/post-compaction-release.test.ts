// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Tests for the post-compaction continuation lifecycle release path
 * (RFC §4.4) extracted from agent-runner.ts:1617-1700.
 *
 * Pins the integration of the three steps that fire AFTER both
 * `continuationEnabledForPressure` and `preflightCompactionApplied` gates:
 *
 *   1. `clearContextPressureState(sessionKey)` runs first.
 *   2. `checkContextPressure({ postCompaction: true })` is consulted and
 *      its return value (when truthy) is enqueued as a system event.
 *   3. `claimStagedPostCompactionTaskFlowDelegates(sessionKey)` is drained and
 *      each returned delegate is dispatched with the canonical flag set
 *      (`silentAnnounce: true, wakeOnReturn: true,
 *       drainsContinuationDelegateQueue: true`) via
 *      `dispatchStagedPostCompactionDelegates` → `spawnSubagentDirect`.
 *
 * Negative paths covered by the agent-runner caller are pinned at the
 * helper boundary: when no delegates are staged, no spawn fires; when
 * pressure inputs are absent, no pressure event is enqueued.
 *
 * The agent-runner-side `preflightCompactionApplied === false` /
 * `continuationEnabledForPressure === false` gates are caller-side
 * checks (verified by code reading) — the helper itself runs only when
 * both are satisfied. See `agent-runner.ts:1621`.
 *
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { releasePostCompactionLifecycle } from "./post-compaction-release.js";

const mockState = vi.hoisted(() => ({
  assertStagedPostCompactionFinalizationComplete: vi.fn(
    (params: { flowIds: readonly (string | undefined)[]; finalized: number; context: string }) => {
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

const SESSION_KEY = "channel:session-211";

const ORIGINATING = {
  originatingChannel: "discord",
  originatingAccountId: "default",
  originatingTo: "channel:CHANNEL_A",
  originatingThreadId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState.finalizeStagedPostCompactionDelegates.mockImplementation(
    (flowIds: readonly (string | undefined)[]) => flowIds.filter(Boolean).length,
  );
  mockState.spawnSubagentDirect.mockResolvedValue({ status: "accepted" });
});

describe("releasePostCompactionLifecycle", () => {
  it("happy path: clears pressure state, fires post-compaction pressure event, and dispatches each staged delegate with the canonical flag set", async () => {
    mockState.checkContextPressure.mockReturnValue("[continuation] post-compaction band fired");
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([
      { task: "rehydrate working state for issue X", flowId: "pc-flow-x" },
      { task: "rehydrate working state for issue Y", flowId: "pc-flow-y" },
    ]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    // (1) Pressure dedup cleared FIRST so the post-compaction band fires fresh.
    expect(mockState.clearContextPressureState).toHaveBeenCalledTimes(1);
    expect(mockState.clearContextPressureState).toHaveBeenCalledWith(SESSION_KEY);

    // (2) Pressure check consulted with postCompaction: true and the
    //     returned text enqueued as a system event for this session.
    expect(mockState.checkContextPressure).toHaveBeenCalledTimes(1);
    expect(mockState.checkContextPressure).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: SESSION_KEY,
        totalTokens: 180_000,
        contextWindow: 200_000,
        threshold: 0.8,
        postCompaction: true,
      }),
    );
    expect(mockState.enqueueSystemEvent).toHaveBeenCalledWith(
      "[continuation] post-compaction band fired",
      { sessionKey: SESSION_KEY, trusted: true },
    );

    // (3) Two staged delegates → exactly two spawn calls, each with the
    //     canonical post-compaction flag set.
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(2);
    for (const call of mockState.spawnSubagentDirect.mock.calls) {
      const [params, ctx] = call;
      expect(params).toEqual(
        expect.objectContaining({
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
        }),
      );
      expect(ctx).toEqual(
        expect.objectContaining({
          agentSessionKey: SESSION_KEY,
          agentChannel: ORIGINATING.originatingChannel,
          agentAccountId: ORIGINATING.originatingAccountId,
          agentTo: ORIGINATING.originatingTo,
        }),
      );
    }
    expect(mockState.spawnSubagentDirect.mock.calls[0]?.[0]?.task).toEqual(
      expect.stringContaining("rehydrate working state for issue X"),
    );
    expect(mockState.spawnSubagentDirect.mock.calls[1]?.[0]?.task).toEqual(
      expect.stringContaining("rehydrate working state for issue Y"),
    );
    expect(mockState.finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([
      "pc-flow-x",
      "pc-flow-y",
    ]);

    expect(result).toEqual({ pressureFired: true, delegatesDispatched: 2 });
  });

  it("finalizes only accepted post-compaction handoffs", async () => {
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([
      { task: "accepted post-compaction handoff", flowId: "pc-flow-accepted" },
      { task: "rejected post-compaction handoff", flowId: "pc-flow-rejected" },
    ]);
    mockState.spawnSubagentDirect
      .mockResolvedValueOnce({ status: "accepted" })
      .mockResolvedValueOnce({ status: "rejected", error: "capacity" });

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    expect(result).toEqual({ pressureFired: false, delegatesDispatched: 1 });
    expect(mockState.finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([
      "pc-flow-accepted",
    ]);
  });

  it("fails direct release when an accepted row was not finalized", async () => {
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([
      { task: "accepted post-compaction handoff", flowId: "pc-flow-accepted" },
    ]);
    mockState.finalizeStagedPostCompactionDelegates.mockReturnValue(0);

    await expect(
      releasePostCompactionLifecycle({
        sessionKey: SESSION_KEY,
        cfg: undefined,
        agentCfgContextTokens: 200_000,
        activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
        originating: ORIGINATING,
      }),
    ).rejects.toThrow("finalized 0/1");

    expect(mockState.finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([
      "pc-flow-accepted",
    ]);
    expect(mockState.assertStagedPostCompactionFinalizationComplete).toHaveBeenCalledWith({
      flowIds: ["pc-flow-accepted"],
      finalized: 0,
      context: `direct post-compaction release for ${SESSION_KEY}`,
    });
  });

  it("no staged delegates: fires the pressure event but performs no spawns", async () => {
    mockState.checkContextPressure.mockReturnValue("[continuation] post-compaction band fired");
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    expect(mockState.clearContextPressureState).toHaveBeenCalledWith(SESSION_KEY);
    expect(mockState.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mockState.spawnSubagentDirect).not.toHaveBeenCalled();
    expect(result).toEqual({ pressureFired: true, delegatesDispatched: 0 });
  });

  it("pressure check returns nothing: no pressure event enqueued, but delegates still dispatch", async () => {
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([{ task: "rehydrate Z" }]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    expect(mockState.clearContextPressureState).toHaveBeenCalledWith(SESSION_KEY);
    expect(mockState.checkContextPressure).toHaveBeenCalledTimes(1);
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pressureFired: false, delegatesDispatched: 1 });
  });

  it("missing totalTokens: skips pressure check + enqueue but still consumes/dispatches staged delegates", async () => {
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([{ task: "rehydrate W" }]);

    const result = await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: null, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    expect(mockState.clearContextPressureState).toHaveBeenCalledWith(SESSION_KEY);
    expect(mockState.checkContextPressure).not.toHaveBeenCalled();
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.spawnSubagentDirect).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pressureFired: false, delegatesDispatched: 1 });
  });

  it("ordering: pressure-state clear runs before consumeStaged + pressure check", async () => {
    const order: string[] = [];
    mockState.clearContextPressureState.mockImplementation(() => {
      order.push("clear");
    });
    mockState.checkContextPressure.mockImplementation(() => {
      order.push("check");
      return undefined;
    });
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockImplementation(() => {
      order.push("consume");
      return [];
    });

    await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 200_000,
      activeSessionEntry: { totalTokens: 180_000, contextTokens: 200_000 },
      originating: ORIGINATING,
    });

    // RFC §4.4: clear pressure dedup BEFORE checking pressure (so the
    // post-compaction band can fire fresh) and BEFORE consuming
    // delegates (so any pressure system event is enqueued ahead of
    // delegate spawns).
    expect(order).toEqual(["clear", "check", "consume"]);
  });

  it("falls back through agentCfgContextTokens → activeSessionEntry.contextTokens → DEFAULT_CONTEXT_TOKENS for pressure window", async () => {
    mockState.checkContextPressure.mockReturnValue(undefined);
    mockState.claimStagedPostCompactionTaskFlowDelegates.mockReturnValue([]);

    // Case A: agentCfgContextTokens wins.
    await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: 100_000,
      activeSessionEntry: { totalTokens: 50_000, contextTokens: 9_999 },
      originating: ORIGINATING,
    });
    expect(mockState.checkContextPressure).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextWindow: 100_000 }),
    );

    // Case B: activeSessionEntry.contextTokens wins when agentCfgContextTokens absent.
    await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: undefined,
      activeSessionEntry: { totalTokens: 50_000, contextTokens: 75_000 },
      originating: ORIGINATING,
    });
    expect(mockState.checkContextPressure).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextWindow: 75_000 }),
    );

    // Case C: DEFAULT_CONTEXT_TOKENS is the floor when both absent.
    await releasePostCompactionLifecycle({
      sessionKey: SESSION_KEY,
      cfg: undefined,
      agentCfgContextTokens: undefined,
      activeSessionEntry: { totalTokens: 50_000, contextTokens: undefined },
      originating: ORIGINATING,
    });
    expect(mockState.checkContextPressure).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextWindow: DEFAULT_CONTEXT_TOKENS }),
    );
  });
});
