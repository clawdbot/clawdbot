import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterUsage } from "./usage.js";

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("OpenRouter usage", () => {
  it("combines account credits with key quota and period spend", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/credits")) {
        return Response.json({ data: { total_credits: 100, total_usage: 35.5 } });
      }
      return Response.json({
        data: {
          label: "Production",
          limit: 20,
          limit_remaining: 15,
          limit_reset: "monthly",
          usage: 35,
          usage_daily: 1.25,
          usage_weekly: 3.5,
          usage_monthly: 5,
        },
      });
    });

    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      provider: "openrouter",
      displayName: "OpenRouter",
      windows: [{ label: "Monthly key budget", usedPercent: 25 }],
      billing: [
        { type: "balance", label: "Account balance", amount: 64.5, unit: "USD" },
        { type: "spend", label: "Account usage", amount: 35.5, unit: "USD" },
        {
          type: "budget",
          label: "API key budget",
          used: 5,
          limit: 20,
          unit: "USD",
          period: "monthly",
        },
      ],
      summary: "$1.25 today · $3.50 this week · $5.00 this month",
      plan: "Production",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("derives recurring budget usage from remaining credits when the period counter is absent", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? new Response(null, { status: 403 })
          : Response.json({
              data: {
                limit: 50,
                limit_remaining: 42,
                limit_reset: "weekly",
                usage: 200,
              },
            }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows).toEqual([{ label: "Weekly key budget", usedPercent: 16 }]);
    expect(snapshot.billing).toEqual([
      {
        type: "budget",
        label: "API key budget",
        used: 8,
        limit: 50,
        unit: "USD",
        period: "weekly",
      },
    ]);
  });

  it("preserves an exhausted zero-dollar key limit", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? new Response(null, { status: 403 })
          : Response.json({
              data: {
                limit: 0,
                limit_remaining: 0,
                limit_reset: "monthly",
                usage_monthly: 0,
              },
            }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows).toEqual([{ label: "Monthly key budget", usedPercent: 100 }]);
    expect(snapshot.billing).toEqual([
      {
        type: "budget",
        label: "API key budget",
        used: 0,
        limit: 0,
        unit: "USD",
        period: "monthly",
      },
    ]);
  });

  it("uses remaining credits when BYOK spend counts toward a recurring limit", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? new Response(null, { status: 403 })
          : Response.json({
              data: {
                limit: 20,
                limit_remaining: 14,
                limit_reset: "monthly",
                usage_monthly: 5,
                byok_usage_monthly: 1,
                include_byok_in_limit: true,
              },
            }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows).toEqual([{ label: "Monthly key budget", usedPercent: 30 }]);
    expect(snapshot.billing).toEqual([
      {
        type: "budget",
        label: "API key budget",
        used: 6,
        limit: 20,
        unit: "USD",
        period: "monthly",
      },
    ]);
  });

  it("keeps key usage when account credits are unavailable", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? new Response(null, { status: 403 })
          : Response.json({ data: { usage: 2.5 } }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.billing).toEqual([
      { type: "spend", label: "API key usage", amount: 2.5, unit: "USD" },
    ]);
  });

  it("preserves an overdrawn account balance", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? Response.json({ data: { total_credits: 10, total_usage: 12.5 } })
          : new Response(null, { status: 403 }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.billing).toEqual([
      { type: "balance", label: "Account balance", amount: -2.5, unit: "USD" },
      { type: "spend", label: "Account usage", amount: 12.5, unit: "USD" },
    ]);
  });

  it("keeps key usage when the credits request fails in transport", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/credits")) {
          throw new Error("network down");
        }
        return Response.json({ data: { usage: 2.5 } });
      }) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.billing).toEqual([
      { type: "spend", label: "API key usage", amount: 2.5, unit: "USD" },
    ]);
  });

  it("keeps key usage when the credits response has a malformed root", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? Response.json(null)
          : Response.json({ data: { usage: 2.5 } }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.billing).toEqual([
      { type: "spend", label: "API key usage", amount: 2.5, unit: "USD" },
    ]);
  });

  it("returns a bounded HTTP error when neither endpoint is available", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(
        async () => new Response("private", { status: 401 }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBe("HTTP 401");
    expect(snapshot.windows).toEqual([]);
  });
});
