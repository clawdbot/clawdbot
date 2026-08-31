// Covers Codex provider usage fetch parsing.
import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

describe("fetchCodexUsage", () => {
  it.each([401, 403])("returns token expired for a %s auth failure", async (status) => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(status, { error: "unauthorized" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("Token expired");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP status errors for non-auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "throttled" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("returns a stable error for malformed successful usage JSON", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, "{not json"));

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);

    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toHaveLength(0);
  });

  it("parses windows, reset times, plan, and credit balance", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      expect(headers.originator).toBe("openclaw");
      expect(headers["User-Agent"]).toMatch(/^openclaw\//);
      return makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 35.5,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            limit_window_seconds: 86_400,
            used_percent: 75,
            reset_at: 1_700_050_000,
          },
        },
        plan_type: "Plus",
        credits: { balance: "12.5" },
      });
    });

    const result = await fetchCodexUsage("token", "acct-1", 5000, mockFetch);

    expect(result.provider).toBe("openai");
    expect(result.plan).toBe("Plus");
    expect(result.billing).toEqual([{ type: "balance", amount: 12.5, unit: "credits" }]);
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 35.5, resetAt: 1_700_000_000_000 },
      { label: "Day", usedPercent: 75, resetAt: 1_700_050_000_000 },
    ]);
  });

  it("labels weekly secondary window as Week", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 7,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            used_percent: 10,
            reset_at: 1_700_500_000,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 7, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: 10, resetAt: 1_700_500_000_000 },
    ]);
  });

  it("labels secondary window as Week when reset cadence clearly exceeds one day", async () => {
    const primaryReset = 1_700_000_000;
    const weeklyLikeSecondaryReset = primaryReset + 5 * 24 * 60 * 60;
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 14,
            reset_at: primaryReset,
          },
          secondary_window: {
            // Observed in production: API reports 24h, but dashboard shows a weekly window.
            limit_window_seconds: 86_400,
            used_percent: 20,
            reset_at: weeklyLikeSecondaryReset,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 14, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: 20, resetAt: weeklyLikeSecondaryReset * 1000 },
    ]);
  });

  it("labels short secondary windows in hours", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          secondary_window: {
            limit_window_seconds: 21_600,
            used_percent: 11,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([{ label: "6h", usedPercent: 11, resetAt: undefined }]);
  });

  it("includes every additional metered quota window", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            used_percent: 8,
            reset_at: 1_700_000_000,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "codex_other",
            metered_feature: "codex_other",
            rate_limit: {
              primary_window: {
                limit_window_seconds: 900,
                used_percent: 70,
                reset_at: 1_700_000_900,
              },
            },
          },
          {
            limit_name: "GPT 5.3 Codex Spark",
            metered_feature: "codex_bengalfox",
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18_000,
                used_percent: 20,
                reset_at: 1_700_001_800,
              },
              secondary_window: {
                limit_window_seconds: 604_800,
                used_percent: 30,
                reset_at: 1_700_604_800,
              },
            },
          },
        ],
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 8, resetAt: 1_700_000_000_000 },
      {
        label: "codex other · 15m",
        groupLabel: "codex other",
        windowLabel: "15m",
        usedPercent: 70,
        resetAt: 1_700_000_900_000,
      },
      {
        label: "GPT 5.3 Codex Spark · 5h",
        groupLabel: "GPT 5.3 Codex",
        windowLabel: "Spark · 5h",
        usedPercent: 20,
        resetAt: 1_700_001_800_000,
      },
      {
        label: "GPT 5.3 Codex Spark · Week",
        groupLabel: "GPT 5.3 Codex",
        windowLabel: "Spark · Week",
        usedPercent: 30,
        resetAt: 1_700_604_800_000,
      },
    ]);
  });

  it("parses the account spend limit and reached state", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        spend_control: {
          reached: false,
          individual_limit: {
            limit: "25000",
            used: "8000",
            used_percent: 32,
            remaining_percent: 68,
            reset_at: 1_700_000_789,
          },
        },
        rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);

    expect(result.windows).toEqual([
      { label: "Monthly spend", usedPercent: 32, resetAt: 1_700_000_789_000 },
    ]);
    expect(result.billing).toEqual([
      {
        type: "budget",
        label: "Monthly spend limit",
        used: 8000,
        limit: 25000,
        unit: "credits",
        period: "monthly",
        resetAt: 1_700_000_789_000,
      },
    ]);
    expect(result.summary).toBe("Workspace credits depleted — ask an owner to refill");
  });

  it("explains who can change a workspace member's spend cap", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);

    expect(result.summary).toBe("Workspace spend cap reached — ask an owner to increase it");
  });

  it("shows a reached spend limit as exhausted", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        spend_control: {
          reached: true,
          individual_limit: { used_percent: 91, reset_at: 1_700_000_789 },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);

    expect(result.windows).toEqual([
      { label: "Monthly spend", usedPercent: 100, resetAt: 1_700_000_789_000 },
    ]);
    expect(result.summary).toBe("Monthly spend limit reached");
  });

  it("ignores malformed successful fields without throwing", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: "unexpected",
        additional_rate_limits: [null, 42, { rate_limit: "unexpected" }],
        plan_type: { name: "Plus" },
        credits: { balance: { amount: 12 } },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);

    expect(result).toMatchObject({ provider: "openai", windows: [] });
    expect(result.plan).toBeUndefined();
    expect(result.billing).toBeUndefined();
  });

  it("keeps credits as a provider unit instead of assuming dollars", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        credits: { balance: "7.5" },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.plan).toBeUndefined();
    expect(result.billing).toEqual([{ type: "balance", amount: 7.5, unit: "credits" }]);
    expect(result.windows).toStrictEqual([]);
  });

  it("omits invalid credit strings", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        plan_type: "Plus",
        credits: { balance: "not-a-number" },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.plan).toBe("Plus");
    expect(result.billing).toBeUndefined();
  });
});
