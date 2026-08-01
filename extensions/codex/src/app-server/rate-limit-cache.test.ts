// Codex tests cover physical-client rate-limit snapshot ownership and rolling merges.
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import {
  mergeCodexRateLimitsUpdate,
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";

function clientIdentity(): CodexAppServerClient {
  return {} as unknown as CodexAppServerClient;
}

describe("Codex rate-limit cache", () => {
  it("isolates snapshots by physical client", () => {
    const first = clientIdentity();
    const second = clientIdentity();
    expect(readCodexRateLimitsRevision(first)).toBe(0);
    rememberCodexRateLimitsRead(first, { rateLimits: { limitId: "first" } }, 100);
    rememberCodexRateLimitsRead(second, { rateLimits: { limitId: "second" } }, 200);
    expect(readCodexRateLimitsRevision(first, "first")).toBe(1);
    expect(readCodexRateLimitsRevision(second, "second")).toBe(1);

    expect(readRecentCodexRateLimits(first, { nowMs: 250 })).toEqual({
      rateLimits: { limitId: "first" },
    });
    expect(readRecentCodexRateLimits(second, { nowMs: 250 })).toEqual({
      rateLimits: { limitId: "second" },
    });
    expect(readRecentCodexRateLimits(first, { nowMs: 301, maxAgeMs: 200 })).toBeUndefined();
    expect(readRecentCodexRateLimits(second, { nowMs: 301, maxAgeMs: 200 })).toEqual({
      rateLimits: { limitId: "second" },
    });
  });

  it("merges sparse rolling updates without clearing account metadata", () => {
    const client = clientIdentity();
    const codexSnapshot = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1000 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2000 },
      credits: { hasCredits: true, unlimited: false, balance: "5" },
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAt: 3000,
      },
      planType: "pro",
      rateLimitReachedType: "rate_limit_reached",
    };
    const otherSnapshot = {
      limitId: "codex_other",
      limitName: "Other",
      primary: { usedPercent: 30, windowDurationMins: 60, resetsAt: 4000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: "pro",
      rateLimitReachedType: null,
    };
    rememberCodexRateLimitsRead(client, {
      rateLimits: codexSnapshot,
      rateLimitsByLimitId: { codex: codexSnapshot, codex_other: otherSnapshot },
    });

    mergeCodexRateLimitsUpdate(client, {
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 5000 },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      },
    });
    mergeCodexRateLimitsUpdate(client, {
      rateLimits: {
        limitId: "codex_other",
        limitName: null,
        primary: { usedPercent: 75, windowDurationMins: 60, resetsAt: 6000 },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      },
    });
    expect(readCodexRateLimitsRevision(client)).toBe(2);
    expect(readCodexRateLimitsRevision(client, "codex_other")).toBe(2);

    const mergedCodexSnapshot = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 5000 },
      secondary: null,
      credits: codexSnapshot.credits,
      individualLimit: codexSnapshot.individualLimit,
      planType: "pro",
      rateLimitReachedType: null,
    };
    const mergedOtherSnapshot = {
      limitId: "codex_other",
      limitName: null,
      primary: { usedPercent: 75, windowDurationMins: 60, resetsAt: 6000 },
      secondary: null,
      credits: codexSnapshot.credits,
      individualLimit: codexSnapshot.individualLimit,
      planType: "pro",
      rateLimitReachedType: null,
    };
    expect(readRecentCodexRateLimits(client)).toEqual({
      rateLimits: mergedCodexSnapshot,
      rateLimitsByLimitId: {
        codex: mergedCodexSnapshot,
        codex_other: mergedOtherSnapshot,
      },
    });
  });
});
