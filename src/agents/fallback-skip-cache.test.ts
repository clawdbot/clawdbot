// Exercises per-session fallback skip markers, TTL expiry, and opt-in cache defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFallbackCandidateSkipReason,
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";
import {
  listFallbackSkipCacheSessionIdsForTest,
  resetFallbackSkipCacheForTest,
} from "./fallback-skip-cache.test-support.js";

describe("fallback-skip-cache", () => {
  beforeEach(() => {
    resetFallbackSkipCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("prunes expired buckets from sessions that are never queried again", () => {
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

    expect(listFallbackSkipCacheSessionIdsForTest()).toEqual(["one-off-1", "one-off-2"]);

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

    expect(listFallbackSkipCacheSessionIdsForTest()).toEqual(["later"]);
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
  });

  it("does not enable the cache for a suffixed TTL value", () => {
    vi.stubEnv("OPENCLAW_FALLBACK_SKIP_TTL_MS", "1000ms");
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
  });

  it("uses OPENCLAW_FALLBACK_SKIP_TTL_MS as an opt-in default TTL", () => {
    vi.stubEnv("OPENCLAW_FALLBACK_SKIP_TTL_MS", "60000");
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
  });
});
