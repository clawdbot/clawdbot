import { beforeEach, describe, expect, it } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  type UsageSummary,
} from "./provider-usage.js";
import { loadUsageWithAuth } from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();

describe("provider usage formatting", () => {
  beforeEach(() => {
    resetProviderUsageSnapshotWithPluginMock();
  });

  it("returns null when no usage is available", () => {
    const summary: UsageSummary = { updatedAt: 0, providers: [] };
    expect(formatUsageSummaryLine(summary)).toBeNull();
  });

  it("picks the most-used window for summary line", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 60 },
          ],
        },
      ],
    };
    const line = formatUsageSummaryLine(summary, { now: 0 });
    expect(line).toContain("Claude");
    expect(line).toContain("40% left");
    expect(line).toContain("(Week");
  });

  it("prints provider errors in report output", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
        },
      ],
    };
    const lines = formatUsageReportLines(summary);
    expect(lines.join("\n")).toContain("Codex: Token expired");
  });

  it("includes reset countdowns in report lines", () => {
    const now = Date.UTC(2026, 0, 7, 0, 0, 0);
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "5h", usedPercent: 20, resetAt: now + 60_000 }],
        },
      ],
    };
    const lines = formatUsageReportLines(summary, { now });
    expect(lines.join("\n")).toContain("resets 1m");
  });
});

describe("provider usage loading", () => {
  it("loads usage snapshots with injected auth", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "anthropic":
            return {
              provider,
              displayName: "Claude",
              windows: [{ label: "5h", usedPercent: 20 }],
            };
          case "minimax":
            return {
              provider,
              displayName: "MiniMax",
              windows: [{ label: "5h", usedPercent: 75 }],
              plan: "Coding Plan",
            };
          case "zai":
            return {
              provider,
              displayName: "Z.ai",
              windows: [{ label: "3h", usedPercent: 25 }],
              plan: "Pro",
            };
          default:
            return null;
        }
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-1" },
        { provider: "minimax", token: "token-1b" },
        { provider: "zai", token: "token-2" },
      ],
      mockFetch,
    );

    expect(summary.providers).toHaveLength(3);
    const claude = summary.providers.find((p) => p.provider === "anthropic");
    const minimax = summary.providers.find((p) => p.provider === "minimax");
    const zai = summary.providers.find((p) => p.provider === "zai");
    expect(claude?.windows[0]?.label).toBe("5h");
    expect(minimax?.windows[0]?.usedPercent).toBe(75);
    expect(zai?.plan).toBe("Pro");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
