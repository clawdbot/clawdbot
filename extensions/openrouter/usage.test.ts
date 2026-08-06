import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
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

  it("keeps custom provider credentials on the configured usage origin", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));

    await fetchOpenRouterUsage({
      token: "synthetic-private-proxy-key",
      baseUrl: "https://private.example.invalid/router/v1///",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://private.example.invalid/router/v1/credits",
      "https://private.example.invalid/router/v1/key",
    ]);
    for (const [, options] of fetchFn.mock.calls) {
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer synthetic-private-proxy-key",
      );
    }
  });

  it("preserves configured request headers and custom auth for both proxy usage endpoints", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));

    await fetchOpenRouterUsage({
      token: "synthetic-original-key",
      baseUrl: "https://private.example.invalid/router/v1",
      request: {
        headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" },
        auth: { mode: "header", headerName: "X-Proxy-Key", value: "synthetic-override-key" },
      },
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    for (const [, options] of fetchFn.mock.calls) {
      const headers = new Headers(options?.headers);
      expect(headers.get("x-private-proxy-tenant")).toBe("synthetic-tenant");
      expect(headers.get("x-proxy-key")).toBe("synthetic-override-key");
      expect(headers.has("authorization")).toBe(false);
      expect(options?.redirect).toBe("manual");
    }
  });

  it.each([
    "http://127.0.0.1:17455/private/v1",
    "http://10.25.30.40:17455/private/v1",
    "http://192.168.25.40:17455/private/v1",
    "http://[::1]:17455/private/v1",
  ])("blocks explicitly denied private usage destinations before fetch: %s", async (baseUrl) => {
    const fetchFn = vi.fn(async () => Response.json({ data: { usage: 1 } }));

    const snapshot = await fetchOpenRouterUsage({
      token: "synthetic-original-key",
      baseUrl,
      request: {
        allowPrivateNetwork: false,
        auth: { mode: "header", headerName: "X-Proxy-Key", value: "synthetic-proxy-secret" },
      },
      timeoutMs: 1000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ provider: "openrouter", error: "Usage unavailable" });
  });

  it("preserves explicitly allowed private-origin usage requests", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));

    await fetchOpenRouterUsage({
      token: "synthetic-private-key",
      baseUrl: "http://127.0.0.1:17455/private/v1",
      request: { allowPrivateNetwork: true },
      timeoutMs: 1000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:17455/private/v1/credits",
      "http://127.0.0.1:17455/private/v1/key",
    ]);
  });

  it("trusts only the operator-configured private origin when no deny policy is set", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));

    await fetchOpenRouterUsage({
      token: "synthetic-private-key",
      baseUrl: "http://127.0.0.1:17455/private/v1",
      timeoutMs: 1000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:17455/private/v1/credits",
      "http://127.0.0.1:17455/private/v1/key",
    ]);
  });

  it.each([
    {
      name: "explicit corporate proxy",
      request: {
        proxy: {
          mode: "explicit-proxy" as const,
          url: "https://corporate-proxy.example.invalid:8443",
          tls: { ca: "synthetic-proxy-ca" },
        },
      },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "https://corporate-proxy.example.invalid:8443",
        proxyTls: { ca: "synthetic-proxy-ca" },
      },
    },
    {
      name: "direct mutual TLS",
      request: {
        tls: {
          ca: "synthetic-private-ca",
          cert: "synthetic-client-certificate",
          key: "synthetic-client-key",
        },
      },
      dispatcherPolicy: {
        mode: "direct",
        connect: {
          ca: "synthetic-private-ca",
          cert: "synthetic-client-certificate",
          key: "synthetic-client-key",
        },
      },
    },
  ])(
    "routes $name through canonical guarded transport instead of the ambient proxy wrapper",
    async ({ request, dispatcherPolicy }) => {
      const ambientProxyFetch = vi.fn(async () => Response.json({ data: { usage: 1 } }));
      const canonicalRuntimeFetch = vi.fn(async () => Response.json({ data: { usage: 1 } }));
      const release = vi.fn(async () => undefined);
      const guardedFetch = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockImplementation(async (params) => {
          const selectedFetch = params.fetchImpl ?? canonicalRuntimeFetch;
          return {
            response: await selectedFetch(params.url, params.init),
            finalUrl: params.url,
            release,
          };
        });

      try {
        await fetchOpenRouterUsage({
          token: "synthetic-private-key",
          baseUrl: "https://private.example.invalid/router/v1",
          request,
          timeoutMs: 1000,
          fetchFn: ambientProxyFetch as unknown as typeof fetch,
        });

        expect(guardedFetch).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(2);
        expect(ambientProxyFetch).not.toHaveBeenCalled();
        expect(canonicalRuntimeFetch).toHaveBeenCalledTimes(2);
        for (const [params] of guardedFetch.mock.calls) {
          expect(params.dispatcherPolicy).toMatchObject(dispatcherPolicy);
          expect(params.fetchImpl).toBeUndefined();
          expect(params.maxRedirects).toBe(0);
          expect(params.timeoutMs).toBe(1000);
          expect(params.policy).toEqual({ allowedOrigins: ["https://private.example.invalid"] });
        }
      } finally {
        guardedFetch.mockRestore();
      }
    },
  );

  it("surfaces blocked usage redirects without replaying private credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example.invalid/capture" },
        }),
    );

    const snapshot = await fetchOpenRouterUsage({
      token: "synthetic-private-key",
      baseUrl: "https://private.example.invalid/router/v1",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(snapshot).toMatchObject({
      provider: "openrouter",
      windows: [],
      error: "Usage unavailable",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://private.example.invalid/router/v1/credits",
      "https://private.example.invalid/router/v1/key",
    ]);
  });

  it.each([
    {
      name: "HTTP failure",
      createResponse: () => new Response(null, { status: 403 }),
      error: "HTTP 403",
    },
    {
      name: "malformed response",
      createResponse: () => Response.json({ invalid: true }),
      error: "Malformed usage response",
    },
  ])("releases both guarded transports after $name", async ({ createResponse, error }) => {
    const fetchFn = vi.fn(async () => createResponse());
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi
      .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
      .mockImplementation(async (params) => {
        if (!params.fetchImpl) {
          throw new Error("expected the operator-owned usage fetch implementation");
        }
        return {
          response: await params.fetchImpl(params.url, params.init),
          finalUrl: params.url,
          release,
        };
      });

    try {
      const snapshot = await fetchOpenRouterUsage({
        token: "synthetic-private-key",
        baseUrl: "https://private.example.invalid/router/v1",
        timeoutMs: 1000,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(snapshot.error).toContain(error);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      guardedFetch.mockRestore();
    }
  });

  it("rejects malformed custom destinations without invoking either usage request", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: {} }));

    await expect(
      fetchOpenRouterUsage({
        token: "synthetic-private-key",
        baseUrl: "file:///tmp/openrouter-usage",
        timeoutMs: 5000,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Invalid OpenRouter API base URL");
    expect(fetchFn).not.toHaveBeenCalled();
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

  it.each([
    { period: "daily", usageKey: "usage_daily", byokKey: "byok_usage_daily" },
    { period: "weekly", usageKey: "usage_weekly", byokKey: "byok_usage_weekly" },
    { period: "monthly", usageKey: "usage_monthly", byokKey: "byok_usage_monthly" },
    { period: undefined, usageKey: "usage", byokKey: "byok_usage" },
  ])(
    "includes $period BYOK spend in key budgets when remaining credits are unavailable",
    async ({ period, usageKey, byokKey }) => {
      const snapshot = await fetchOpenRouterUsage({
        token: "router-key",
        timeoutMs: 5000,
        fetchFn: vi.fn(async (input: string | URL | Request) =>
          requestUrl(input).endsWith("/credits")
            ? new Response(null, { status: 403 })
            : Response.json({
                data: {
                  limit: 20,
                  ...(period ? { limit_reset: period } : {}),
                  [usageKey]: 5,
                  [byokKey]: 4,
                  include_byok_in_limit: true,
                },
              }),
        ) as unknown as typeof fetch,
      });

      expect(snapshot.windows[0]?.usedPercent).toBe(45);
      expect(snapshot.billing?.[0]).toMatchObject({
        type: "budget",
        used: 9,
        limit: 20,
        ...(period ? { period } : {}),
      });
    },
  );

  it("excludes BYOK spend from key budgets when the key does not count it", async () => {
    const snapshot = await fetchOpenRouterUsage({
      token: "router-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/credits")
          ? new Response(null, { status: 403 })
          : Response.json({
              data: {
                limit: 20,
                limit_reset: "monthly",
                usage_monthly: 5,
                byok_usage_monthly: 4,
                include_byok_in_limit: false,
              },
            }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows[0]?.usedPercent).toBe(25);
    expect(snapshot.billing?.[0]).toMatchObject({ type: "budget", used: 5, limit: 20 });
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
