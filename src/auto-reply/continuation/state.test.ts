import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateCounts = vi.hoisted(() => ({
  pendingDelegates: 0,
  stagedPostCompaction: 0,
}));

vi.mock("./delegate-store.js", () => ({
  pendingDelegateCount: () => delegateCounts.pendingDelegates,
}));

vi.mock("./delegate-store-post-compaction.js", () => ({
  stagedPostCompactionDelegateCount: () => delegateCounts.stagedPostCompaction,
}));

import {
  clearTrackedContinuationTimers,
  hasDelegatePending,
  hasLiveContinuationTimerRefs,
  loadContinuationChainState,
  persistContinuationChainState,
  registerContinuationTimerHandle,
  releaseContinuationTimerRef,
  resetContinuationStateForTests,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "./state.js";

beforeEach(() => {
  delegateCounts.pendingDelegates = 0;
  delegateCounts.stagedPostCompaction = 0;
  resetContinuationStateForTests();
});

afterEach(() => {
  resetContinuationStateForTests();
});

describe("loadContinuationChainState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns zeroed chain with chainStartedAt=now for undefined source", () => {
    const state = loadContinuationChainState(undefined);
    expect(state.currentChainCount).toBe(0);
    expect(state.chainStartedAt).toBe(Date.now());
    expect(state.accumulatedChainTokens).toBe(0);
  });

  it("reads chain fields directly when all three are present", () => {
    const state = loadContinuationChainState({
      continuationChainCount: 3,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 42_000,
    });
    expect(state).toEqual({
      currentChainCount: 3,
      chainStartedAt: 1_700_000_000_000,
      accumulatedChainTokens: 42_000,
    });
  });

  it("folds turnTokens into accumulatedChainTokens", () => {
    const state = loadContinuationChainState(
      {
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
      },
      2_500,
    );
    expect(state.accumulatedChainTokens).toBe(3_500);
    expect(state.currentChainCount).toBe(1);
    expect(state.chainStartedAt).toBe(1_700_000_000_000);
  });

  it("defaults chainStartedAt to now when field is missing", () => {
    const state = loadContinuationChainState({
      continuationChainCount: 2,
      continuationChainTokens: 100,
    });
    expect(state.chainStartedAt).toBe(Date.now());
    expect(state.currentChainCount).toBe(2);
    expect(state.accumulatedChainTokens).toBe(100);
  });

  it("treats missing count/tokens as zero (no undefined leak into arithmetic)", () => {
    const state = loadContinuationChainState(
      { continuationChainStartedAt: 1_700_000_000_000 },
      500,
    );
    expect(state.currentChainCount).toBe(0);
    expect(state.accumulatedChainTokens).toBe(500);
    expect(state.chainStartedAt).toBe(1_700_000_000_000);
  });

  it("defaults turnTokens to 0 when not provided", () => {
    const state = loadContinuationChainState({
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 777,
    });
    expect(state.accumulatedChainTokens).toBe(777);
  });
});

describe("continuation timer state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks timer refs with retain/release semantics", () => {
    const sessionKey = "timer-refs";

    retainContinuationTimerRef(sessionKey);
    retainContinuationTimerRef(sessionKey);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    releaseContinuationTimerRef(sessionKey);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    releaseContinuationTimerRef(sessionKey);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("registers and unregisters timer handles while releasing refs exactly once", () => {
    const sessionKey = "timer-handles";
    const handle = setTimeout(() => undefined, 1_000);

    retainContinuationTimerRef(sessionKey);
    registerContinuationTimerHandle(sessionKey, handle);

    expect(unregisterContinuationTimerHandle(sessionKey, handle)).toBe(true);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
    expect(unregisterContinuationTimerHandle(sessionKey, handle)).toBe(false);

    clearTimeout(handle);
  });

  it("clears tracked timers and asynchronously releases their refs", async () => {
    const sessionKey = "timer-clear";
    const first = setTimeout(() => undefined, 1_000);
    const second = setTimeout(() => undefined, 2_000);

    retainContinuationTimerRef(sessionKey);
    retainContinuationTimerRef(sessionKey);
    registerContinuationTimerHandle(sessionKey, first);
    registerContinuationTimerHandle(sessionKey, second);

    clearTrackedContinuationTimers(sessionKey);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });
});

describe("hasDelegatePending", () => {
  it("derives pending state from pending and staged TaskFlow counts", () => {
    expect(hasDelegatePending("session")).toBe(false);

    delegateCounts.pendingDelegates = 1;
    expect(hasDelegatePending("session")).toBe(true);

    delegateCounts.pendingDelegates = 0;
    delegateCounts.stagedPostCompaction = 1;
    expect(hasDelegatePending("session")).toBe(true);
  });
});

describe("persistContinuationChainState", () => {
  it("writes continuation chain metadata onto the session entry", () => {
    const sessionEntry = { sessionId: "session", updatedAt: 1 };

    persistContinuationChainState({
      sessionEntry,
      count: 2,
      startedAt: 1_700_000_000_000,
      tokens: 42_000,
    });

    expect(sessionEntry).toMatchObject({
      continuationChainCount: 2,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 42_000,
    });
  });

  it("is a no-op when no session entry is available", () => {
    expect(() =>
      persistContinuationChainState({
        count: 2,
        startedAt: 1_700_000_000_000,
        tokens: 42_000,
      }),
    ).not.toThrow();
  });

  it("persists the chain id alongside depth/start/tokens when provided", () => {
    // Regression anchor for chain-id persistence (state.ts:186): the delegate-drain
    // callers persist an advanced `chainState` carrying the minted chain id;
    // without writing `continuationChainId` here it was dropped and the next
    // drain re-minted a fresh id, breaking stable multi-hop chain correlation.
    const sessionEntry = { sessionId: "session", updatedAt: 1 };

    persistContinuationChainState({
      sessionEntry,
      count: 2,
      startedAt: 1_700_000_000_000,
      tokens: 42_000,
      chainId: "chain-abc",
    });

    expect(sessionEntry).toMatchObject({
      continuationChainCount: 2,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 42_000,
      continuationChainId: "chain-abc",
    });
    // The reader surfaces a persisted `continuationChainId` back as `chainId`
    // on the next hop — the round-trip the drain-drop broke.
    expect(loadContinuationChainState({ continuationChainId: "chain-abc" }).chainId).toBe(
      "chain-abc",
    );
  });

  it("preserves an existing chain id when chainId is omitted (no clobber)", () => {
    const sessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      continuationChainId: "chain-existing",
    };

    persistContinuationChainState({
      sessionEntry,
      count: 5,
      startedAt: 1_700_000_000_000,
      tokens: 10,
    });

    expect(sessionEntry.continuationChainId).toBe("chain-existing");
  });
});
