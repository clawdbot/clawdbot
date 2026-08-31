// Covers provider usage report formatting.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  formatUsageWindowSummary,
} from "./provider-usage.format.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12, 0, 0);

function makeSnapshot(windows: ProviderUsageSnapshot["windows"]): ProviderUsageSnapshot {
  return {
    provider: "anthropic",
    displayName: "Claude",
    windows,
  };
}

describe("provider-usage.format", () => {
  it.each([
    { snapshot: { ...makeSnapshot([]), error: "HTTP 401" } as ProviderUsageSnapshot, now },
    { snapshot: makeSnapshot([]), now },
  ])("returns null summary for empty or errored snapshots", ({ snapshot, now: currentNow }) => {
    expect(formatUsageWindowSummary(snapshot, { now: currentNow })).toBeNull();
  });

  it("formats reset windows across now/minute/hour/day/date buckets", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Now", usedPercent: 10, resetAt: now - 1 },
        { label: "Minute", usedPercent: 20, resetAt: now + 30 * 60_000 },
        { label: "Hour", usedPercent: 30, resetAt: now + 2 * 60 * 60_000 + 15 * 60_000 },
        { label: "Day", usedPercent: 40, resetAt: now + (2 * 24 + 3) * 60 * 60_000 },
        { label: "Date", usedPercent: 50, resetAt: Date.UTC(2026, 0, 20, 12, 0, 0) },
      ]),
      { now, includeResets: true },
    );

    expect(summary).toContain("Now 90% left ⏱now");
    expect(summary).toContain("Minute 80% left ⏱30m");
    expect(summary).toContain("Hour 70% left ⏱2h 15m");
    expect(summary).toContain("Day 60% left ⏱2d 3h");
    expect(summary).toMatch(/Date 50% left ⏱[A-Z][a-z]{2} \d{1,2}/);
  });

  it("honors max windows and reset toggle", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "A", usedPercent: 10, resetAt: now + 60_000 },
        { label: "B", usedPercent: 20, resetAt: now + 120_000 },
        { label: "C", usedPercent: 30, resetAt: now + 180_000 },
      ]),
      { now, maxWindows: 2, includeResets: false },
    );

    expect(summary).toBe("A 90% left · B 80% left");
  });

  it("treats non-positive max windows as all windows and clamps overused percentages", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Over", usedPercent: 120, resetAt: now + 60_000 },
        { label: "Under", usedPercent: -10 },
      ]),
      { now, maxWindows: 0, includeResets: true },
    );

    expect(summary).toBe("Over 0% left ⏱1m · Under 100% left");
  });

  it("formats summary line from highest-usage window and provider cap", () => {
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 20 },
            { label: "Week", usedPercent: 70 },
          ],
        },
        {
          provider: "zai",
          displayName: "z.ai",
          windows: [{ label: "Day", usedPercent: 10 }],
        },
      ],
    };

    expect(formatUsageSummaryLine(summary, { now, maxProviders: 1 })).toBe(
      "📊 Usage: Claude 30% left (Week)",
    );
  });

  it("formats provider summary text for balance-only providers", () => {
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          windows: [],
          summary: "Balance ¥42.50",
        },
      ],
    };

    expect(
      formatUsageWindowSummary(
        expectDefined(summary.providers[0], "summary.providers[0] test invariant"),
        { now },
      ),
    ).toBe("Balance ¥42.50");
    expect(formatUsageSummaryLine(summary, { now })).toBe("📊 Usage: DeepSeek Balance ¥42.50");
    expect(formatUsageReportLines(summary, { now })).toEqual([
      "Usage:",
      "  DeepSeek: Balance ¥42.50",
    ]);
  });

  it("formats typed balances and budgets across compact and detailed surfaces", () => {
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          windows: [],
          plan: "Production",
          billing: [
            { type: "balance", label: "Account balance", amount: 64.5, unit: "USD" },
            {
              type: "budget",
              label: "API key budget",
              used: 5,
              limit: 20,
              unit: "USD",
            },
          ],
        },
      ],
    };

    expect(
      formatUsageWindowSummary(
        expectDefined(summary.providers[0], "summary.providers[0] test invariant"),
        { now },
      ),
    ).toBe("Account balance: $64.50");
    expect(formatUsageSummaryLine(summary, { now })).toBe(
      "📊 Usage: OpenRouter Account balance: $64.50",
    );
    expect(formatUsageReportLines(summary, { now })).toEqual([
      "Usage:",
      "  OpenRouter (Production)",
      "    Account balance: $64.50",
      "    API key budget: $5.00 / $20.00",
    ]);
  });

  it("places a negative currency sign before the symbol", () => {
    expect(
      formatUsageWindowSummary({
        provider: "openrouter",
        displayName: "OpenRouter",
        windows: [],
        billing: [{ type: "balance", amount: -2.5, unit: "USD" }],
      }),
    ).toBe("Balance: -$2.50");
  });

  it("returns null summary line when providers are errored or have no windows", () => {
    expect(
      formatUsageSummaryLine({
        updatedAt: now,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            windows: [],
            error: "HTTP 401",
          },
          {
            provider: "zai",
            displayName: "z.ai",
            windows: [],
          },
        ],
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "formats empty reports",
      summary: { updatedAt: now, providers: [] } as UsageSummary,
      opts: undefined,
      expected: ["Usage: no provider usage available."],
    },
    {
      name: "formats error, no-data, and plan entries",
      summary: {
        updatedAt: now,
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            windows: [],
            error: "Token expired",
            plan: "Plus",
          },
          {
            provider: "xiaomi",
            displayName: "Xiaomi",
            windows: [],
          },
        ],
      } as UsageSummary,
      opts: undefined,
      expected: ["Usage:", "  Codex (Plus): Token expired", "  Xiaomi: no data"],
    },
    {
      name: "formats plan plus summary entries without windows",
      summary: {
        updatedAt: now,
        providers: [
          {
            provider: "deepseek",
            displayName: "DeepSeek",
            windows: [],
            summary: "Balance ¥0.00",
            plan: "Unavailable",
          },
        ],
      } as UsageSummary,
      opts: undefined,
      expected: ["Usage:", "  DeepSeek (Unavailable): Balance ¥0.00"],
    },
    {
      name: "formats detailed report lines with reset windows",
      summary: {
        updatedAt: now,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            plan: "Pro",
            windows: [{ label: "Daily", usedPercent: 25, resetAt: now + 2 * 60 * 60_000 }],
          },
        ],
      } as UsageSummary,
      opts: { now },
      expected: ["Usage:", "  Claude (Pro)", "    Daily: 75% left · resets 2h"],
    },
  ])("$name", ({ summary, opts, expected }) => {
    expect(formatUsageReportLines(summary, opts)).toEqual(expected);
  });
});
