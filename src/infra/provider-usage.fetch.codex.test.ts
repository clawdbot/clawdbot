// Covers Codex provider usage fetch parsing.
import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

describe("fetchCodexUsage", () => {
  it("returns token expired for auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(401, { error: "unauthorized" }),
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
