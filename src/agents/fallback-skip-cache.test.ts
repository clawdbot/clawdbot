// Exercises per-session fallback skip markers, TTL expiry, and opt-in cache defaults.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK_SKIP_TTL_MS,
  resetFallbackSkipCacheForTest,
  clearFallbackSkipCacheForSession,
  getFallbackCandidateSkipReason,
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";

describe("fallback-skip-cache", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
  });

  afterEach(() => {
    resetFallbackSkipCacheForTest();
  });

  it("returns false for an unknown (session, provider, model) triple", () => {
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 1_000,
      }),
    ).toBe(false);
  });

  it("treats falsy sessionId as a no-op for both mark and check", () => {
    // Session scope is required. Without it, a permanent provider/auth failure
    // could suppress fallback candidates across unrelated conversations.
    markFallbackCandidateSkipped({
      sessionId: undefined,
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
    });
    expect(
      isFallbackCandidateSkipped({
        sessionId: undefined,
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 1_000,
      }),
    ).toBe(false);
    expect(
      isFallbackCandidateSkipped({
        sessionId: "",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 1_000,
      }),
    ).toBe(false);
  });

  it("marks then sees a candidate as skipped within the TTL", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 30_000,
      }),
    ).toBe(true);
    expect(
      getFallbackCandidateSkipReason({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 30_000,
      }),
    ).toBe("auth");
  });

  it("expires entries after the TTL elapses", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth_permanent",
      now: 1_000,
      ttlMs: 10_000,
    });

    // Just before expiry, still skipped.
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 10_000,
      }),
    ).toBe(true);
    // At and after expiry, no longer skipped.
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 11_001,
      }),
    ).toBe(false);
    expect(
      getFallbackCandidateSkipReason({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 11_001,
      }),
    ).toBeUndefined();
  });

  it("isolates entries across sessions", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
    });
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s2",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 30_000,
      }),
    ).toBe(false);
  });

  it("isolates entries across (provider, model) pairs", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
    });
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        now: 30_000,
      }),
    ).toBe(false);
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "google",
        model: "claude-opus-4-7",
        now: 30_000,
      }),
    ).toBe(false);
  });

  it("clearFallbackSkipCacheForSession drops every marker for that session", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
    });
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      reason: "auth",
      now: 1_000,
    });
    clearFallbackSkipCacheForSession("s1");
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 30_000,
      }),
    ).toBe(false);
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "google",
        model: "gemini-3.1-pro-preview",
        now: 30_000,
      }),
    ).toBe(false);
  });

  it("re-marking the same triple refreshes the TTL", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
      ttlMs: 10_000,
    });
    // Re-mark just before the original entry would expire.
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth_permanent",
      now: 10_000,
      ttlMs: 10_000,
    });
    // Without refresh, this point would be past expiry. With refresh it lives.
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 19_000,
      }),
    ).toBe(true);
    // The most recent reason wins.
    expect(
      getFallbackCandidateSkipReason({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 19_000,
      }),
    ).toBe("auth_permanent");
  });

  it("prunes expired buckets from sessions that are never queried again", async () => {
    const { peekFallbackSkipBucketsForTest } = await import("./fallback-skip-cache.js");

    // Two short-lived sessions write markers, then never come back.
    markFallbackCandidateSkipped({
      sessionId: "one-off-1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
      ttlMs: 10_000,
    });
    markFallbackCandidateSkipped({
      sessionId: "one-off-2",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      reason: "auth",
      now: 1_000,
      ttlMs: 10_000,
    });

    expect(peekFallbackSkipBucketsForTest().size).toBe(2);

    // A third session writes well after the first two have expired. The
    // opportunistic global prune must drop the stale buckets even though
    // those original sessions are never re-queried.
    markFallbackCandidateSkipped({
      sessionId: "later",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 100_000,
      ttlMs: 10_000,
    });

    const buckets = peekFallbackSkipBucketsForTest();
    expect(buckets.has("one-off-1")).toBe(false);
    expect(buckets.has("one-off-2")).toBe(false);
    expect(buckets.has("later")).toBe(true);
  });

  it("does not skip by default when ttlMs is omitted", () => {
    markFallbackCandidateSkipped({
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      now: 1_000,
    });
    expect(
      isFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        now: 1_000,
      }),
    ).toBe(false);
    expect(DEFAULT_FALLBACK_SKIP_TTL_MS).toBe(0);
  });

  it("uses OPENCLAW_FALLBACK_SKIP_TTL_MS as an opt-in default TTL", () => {
    const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
    process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
    try {
      markFallbackCandidateSkipped({
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-opus-4-7",
        reason: "auth",
        now: 1_000,
      });
      expect(
        isFallbackCandidateSkipped({
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-opus-4-7",
          now: 60_000,
        }),
      ).toBe(true);
      expect(
        isFallbackCandidateSkipped({
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-opus-4-7",
          now: 61_001,
        }),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      } else {
        process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
      }
    }
  });
});
