import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";

describe("fetchZaiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(503, "unavailable"));
    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.error).toBe("HTTP 503");
    expect(result.windows).toHaveLength(0);
  });

  it("returns a stable error for malformed successful usage JSON", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, "{not json"));
    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toHaveLength(0);
  });

  it("returns API message errors for unsuccessful payloads", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        success: false,
        code: 500,
        msg: "quota endpoint disabled",
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);
    expect(result.error).toBe("quota endpoint disabled");
    expect(result.windows).toHaveLength(0);
  });

  it("falls back to a generic API error for blank unsuccessful messages", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        success: false,
        code: 500,
        msg: "   ",
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);
    expect(result.error).toBe("API error");
    expect(result.windows).toHaveLength(0);
  });

  it("parses token and monthly windows with reset times", async () => {
    const tokenReset = "2026-01-08T00:00:00Z";
    const minuteReset = "2026-01-08T00:30:00Z";
    const monthlyReset = "2026-01-31T12:00:00Z";
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        success: true,
        code: 200,
        data: {
          planName: "Team",
          limits: [
            {
              type: "TOKENS_LIMIT",
              percentage: 32,
              unit: 3,
              number: 6,
              nextResetTime: tokenReset,
            },
            {
              type: "TOKENS_LIMIT",
              percentage: 8,
              unit: 5,
              number: 15,
              nextResetTime: minuteReset,
            },
            {
              type: "TIME_LIMIT",
              percentage: 12.5,
              unit: 1,
              number: 30,
              nextResetTime: monthlyReset,
            },
          ],
        },
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.plan).toBe("Team");
    expect(result.windows).toEqual([
      {
        label: "Tokens (6h)",
        usedPercent: 32,
        resetAt: new Date(tokenReset).getTime(),
      },
      {
        label: "Tokens (15m)",
        usedPercent: 8,
        resetAt: new Date(minuteReset).getTime(),
      },
      {
        label: "Monthly",
        usedPercent: 12.5,
        resetAt: new Date(monthlyReset).getTime(),
      },
    ]);
  });

  it("clamps invalid percentages and falls back to alternate plan fields", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        success: true,
        code: 200,
        data: {
          plan: "Pro",
          limits: [
            {
              type: "TOKENS_LIMIT",
              percentage: -5,
              unit: 99,
            },
            {
              type: "TIME_LIMIT",
              percentage: 140,
            },
            {
              type: "OTHER_LIMIT",
              percentage: 50,
            },
          ],
        },
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      {
        label: "Tokens (Limit)",
        usedPercent: 0,
        resetAt: undefined,
      },
      {
        label: "Monthly",
        usedPercent: 100,
        resetAt: undefined,
      },
    ]);
  });
});
