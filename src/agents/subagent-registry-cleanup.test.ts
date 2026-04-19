import { describe, expect, it } from "vitest";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: 0,
    endedAt: 1_000,
    ...overrides,
  };
}

describe("resolveDeferredCleanupDecision", () => {
  const now = 2_000;

  function resolveDecision(
    overrides: Pick<
      Parameters<typeof resolveDeferredCleanupDecision>[0],
      "activeDescendantRuns" | "entry"
    > &
      Partial<
        Pick<Parameters<typeof resolveDeferredCleanupDecision>[0], "resolveAnnounceRetryDelayMs">
      >,
  ) {
    return resolveDeferredCleanupDecision({
      now,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
      ...overrides,
    });
  }

  it("defers completion-message cleanup while descendants are still pending", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true }),
      activeDescendantRuns: 2,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("hard-expires completion-message cleanup when descendants never settle", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true, endedAt: now - (30 * 60_000 + 1) }),
      activeDescendantRuns: 1,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("keeps regular expiry behavior for non-completion flows", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: false, endedAt: now - (5 * 60_000 + 1) }),
      activeDescendantRuns: 0,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry", retryCount: 1 });
  });

  it("uses retry backoff for completion-message flows once descendants are settled", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true, announceRetryCount: 1 }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });

  it("uses retry backoff for non-completion flows so cleanup can settle after announce failures", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: false, announceRetryCount: 1 }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });
});
