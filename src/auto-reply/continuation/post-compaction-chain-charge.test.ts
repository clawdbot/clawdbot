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

vi.mock("../../tasks/task-flow-registry.js", async () => {
  const harness = await import("./delegate-taskflow-registry.test-harness.js");
  return harness.createTaskFlowRegistryMock();
});

import {
  claimStagedPostCompactionTaskFlowDelegates,
  stagePostCompactionTaskFlowDelegate,
} from "./delegate-store-post-compaction.js";
import { markPendingDelegateSpawnAccepted } from "./delegate-store.js";
import { resetMockTaskFlows } from "./delegate-taskflow-registry.test-harness.js";
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
  resetMockTaskFlows();
});

afterEach(() => {
  resetMockTaskFlows();
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
