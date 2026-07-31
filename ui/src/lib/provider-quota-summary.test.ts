// Control UI tests cover provider quota summary behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusProvider } from "../api/types.ts";
import { collectProviderQuotaGroups, formatQuotaReset } from "./provider-quota-summary.ts";

describe("formatQuotaReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns compact relative reset windows", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() + 30 * 60_000)).toBe("30m");
    expect(formatQuotaReset(Date.now() + 2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("returns <1m for sub-minute reset windows instead of 0m", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() - 1)).toBe("now");
    expect(formatQuotaReset(Date.now())).toBe("now");
    expect(formatQuotaReset(Date.now() + 1)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 59_999)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 60_000)).toBe("1m");
  });

  it("ignores Date-invalid reset timestamps", () => {
    expect(formatQuotaReset(8_640_000_000_000_001)).toBeNull();
    expect(formatQuotaReset(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("collectProviderQuotaGroups", () => {
  const acceptAll = () => true;

  function providerWithUsage(
    provider: string,
    usage: ModelAuthStatusProvider["usage"],
  ): ModelAuthStatusProvider {
    return {
      provider,
      displayName: "Claude",
      status: "ok",
      profiles: [{ profileId: `${provider}:default`, type: "oauth", status: "ok" }],
      usage,
    };
  }

  it("collapses providers sharing identical usage into one group", () => {
    const usage: ModelAuthStatusProvider["usage"] = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 21.6, resetAt: 1_800_000_000_000 },
        { label: "Week", usedPercent: 25 },
      ],
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
    };
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [providerWithUsage("anthropic", usage), providerWithUsage("claude-cli", usage)],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["anthropic", "claude-cli"],
        displayName: "Claude",
        plan: "Max (20x)",
        windows: [
          { label: "5h", usedPercent: 22, resetAt: 1_800_000_000_000 },
          { label: "Week", usedPercent: 25 },
        ],
        budgets: [{ used: 157.85, limit: 400, unit: "USD" }],
      },
    ]);
  });

  it("carries the account email and keeps distinct accounts in separate groups", () => {
    const windows = [{ label: "5h", usedPercent: 10 }];
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithUsage("anthropic", {
            providerId: "anthropic",
            accountEmail: "work@example.com",
            windows,
          }),
          providerWithUsage("claude-cli", {
            providerId: "anthropic",
            accountEmail: "personal@example.com",
            windows,
          }),
        ],
      },
      acceptAll,
    );

    expect(groups.map((group) => group.accountEmail)).toEqual([
      "work@example.com",
      "personal@example.com",
    ]);
    expect(groups).toHaveLength(2);
  });

  it("drops providers without windows or budgets and invalid budget shapes", () => {
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithUsage("anthropic", { providerId: "anthropic", windows: [] }),
          providerWithUsage("openrouter", {
            providerId: "openrouter",
            windows: [],
            billing: [
              { type: "balance", amount: 10, unit: "USD" },
              { type: "budget", used: 5, limit: 0, unit: "USD" },
            ],
          }),
          providerWithUsage("openai", {
            providerId: "openai",
            windows: [{ label: "Week", usedPercent: 140 }],
          }),
        ],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["openai"],
        displayName: "Claude",
        windows: [{ label: "Week", usedPercent: 100 }],
        budgets: [],
      },
    ]);
  });

  it("applies the provider filter", () => {
    const usage = { providerId: "anthropic", windows: [{ label: "5h", usedPercent: 10 }] };
    const groups = collectProviderQuotaGroups(
      { ts: 1, providers: [providerWithUsage("anthropic", usage)] },
      () => false,
    );
    expect(groups).toEqual([]);
  });
});
