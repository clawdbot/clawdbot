import { describe, expect, it } from "vitest";
import {
  formatCodexUsageLimitErrorMessage,
  resolveCodexUsageLimitResetAtMs,
  summarizeCodexAccountUsage,
  summarizeCodexRateLimits,
} from "./rate-limits.js";

describe("formatCodexUsageLimitErrorMessage", () => {
  it("preserves Codex retry hints when structured reset windows are absent", () => {
    const message = formatCodexUsageLimitErrorMessage({
      message:
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 9:00 AM.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
      },
      nowMs: Date.UTC(2026, 4, 10, 23, 0, 0),
    });

    expect(message).toContain("You've reached your Codex subscription usage limit.");
    expect(message).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(message).not.toContain("Codex did not return a reset time");
  });

  it("accepts snake_case rate limit snapshots from Codex core payloads", () => {
    const message = formatCodexUsageLimitErrorMessage({
      message: "You've reached your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      rateLimits: {
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1_700_003_600 },
          secondary: null,
        },
      },
      nowMs: 1_700_000_000_000,
    });

    expect(message).toContain("Next reset in 1 hour, ");
    expect(message).toMatch(/\b[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? at \d{1,2}:\d{2} [AP]M\b/u);
    expect(message).not.toMatch(/\(\d{4}-\d{2}-\d{2}T/u);
    expect(message).not.toContain("Codex did not return a reset time");
  });
});

describe("Codex rate limit blocking resets", () => {
  it("keeps subscriptions blocked until all exhausted windows reset", () => {
    const nowMs = 1_700_000_000_000;
    const shortTermReset = Math.ceil(nowMs / 1000) + 60 * 60;
    const weeklyReset = Math.ceil(nowMs / 1000) + 24 * 60 * 60;
    const payload = {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: shortTermReset },
          secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: weeklyReset },
        },
      },
    };

    expect(resolveCodexUsageLimitResetAtMs(payload, nowMs)).toBe(weeklyReset * 1000);
    expect(summarizeCodexAccountUsage(payload, nowMs)?.blockedUntilMs).toBe(weeklyReset * 1000);
  });
});

describe("summarizeCodexRateLimits", () => {
  it("formats status limits like provider usage summaries", () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = nowMs / 1000;

    expect(
      summarizeCodexRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 26,
              windowDurationMins: 300,
              resetsAt: nowSeconds + 3 * 60 * 60,
            },
            secondary: {
              usedPercent: 4,
              windowDurationMins: 7 * 24 * 60,
              resetsAt: nowSeconds + 7 * 24 * 60 * 60,
            },
          },
        },
        nowMs,
      ),
    ).toBe("Codex: primary 74% left ⏱3h · secondary 96% left ⏱7d");
  });

  it("ignores empty named buckets instead of showing them as available limits", () => {
    const nowMs = 1_700_000_000_000;
    const payload = {
      rateLimitsByLimitId: {
        premium: {
          limitId: "premium",
          limitName: "premium",
          primary: null,
          secondary: null,
          credits: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 5,
            windowDurationMins: 300,
            resetsAt: Math.ceil(nowMs / 1000) + 3600,
          },
          secondary: null,
          credits: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
      },
    };

    expect(summarizeCodexRateLimits(payload, nowMs)).toContain("Codex: primary 95% left ⏱1h");
    expect(summarizeCodexRateLimits(payload, nowMs)).not.toContain("premium");
    expect(summarizeCodexAccountUsage(payload, nowMs)?.usageLine).toBe("short-term 5%");
  });

  it("does not render a server-reported usage-limit block as available", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: null,
        secondary: null,
        credits: null,
        rateLimitReachedType: "rate_limit_reached",
      },
    };

    expect(summarizeCodexRateLimits(payload, 1_700_000_000_000)).toBe("Codex: rate limit reached");
    expect(summarizeCodexAccountUsage(payload, 1_700_000_000_000)).toMatchObject({
      blocked: true,
      blockingReason: "Codex usage limit is reached",
    });
  });

  it("ignores metadata-only Codex buckets", () => {
    expect(
      summarizeCodexRateLimits({
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps displayable buckets when sibling buckets are empty", () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = nowMs / 1000;

    expect(
      summarizeCodexRateLimits(
        {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 26, windowDurationMins: 300, resetsAt: nowSeconds + 3600 },
              secondary: null,
              credits: null,
              planType: "plus",
              rateLimitReachedType: null,
            },
            "gpt-5.3-codex-spark": {
              limitId: "gpt-5.3-codex-spark",
              limitName: "GPT 5.3 Codex Spark",
              primary: null,
              secondary: null,
              credits: null,
              planType: "plus",
              rateLimitReachedType: null,
            },
          },
        },
        nowMs,
      ),
    ).toBe("Codex: primary 74% left ⏱1h");
  });
});
