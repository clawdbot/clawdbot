import { describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicAdminUsage,
  fetchAnthropicUsage,
  formatClaudePlanLabel,
  resolveAnthropicUsageAuth,
} from "./usage.js";

vi.mock("openclaw/plugin-sdk/provider-auth", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    readClaudeCliCredentialsCached: vi.fn(() => ({
      type: "oauth",
      provider: "anthropic",
      access: "cli-access",
      refresh: "cli-refresh",
      expires: Date.now() + 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    })),
  };
});

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

describe("Anthropic provider usage", () => {
  it("aggregates provider-reported costs, cache tokens, models, and categories", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/organizations/cost_report")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                starting_at: "2026-07-06T00:00:00Z",
                ending_at: "2026-07-07T00:00:00Z",
                results: [{ amount: "1234", currency: "USD", description: "Claude API" }],
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              starting_at: "2026-07-06T00:00:00Z",
              ending_at: "2026-07-07T00:00:00Z",
              results: [
                {
                  uncached_input_tokens: 1_000,
                  cache_creation: {
                    ephemeral_1h_input_tokens: 100,
                    ephemeral_5m_input_tokens: 50,
                  },
                  cache_read_input_tokens: 300,
                  output_tokens: 250,
                  model: "claude-opus-4-8",
                },
              ],
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    });

    const result = await fetchAnthropicAdminUsage({
      apiKey: "sk-ant-admin-test",
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
      now: Date.parse("2026-07-06T12:00:00Z"),
      periodDays: 2,
    });

    expect(result).toMatchObject({
      provider: "anthropic",
      plan: "Admin API",
      billing: [{ type: "spend", amount: 12.34, unit: "USD", period: "2d" }],
      costHistory: {
        unit: "USD",
        periodDays: 2,
        daily: [
          {
            date: "2026-07-06",
            amount: 12.34,
            inputTokens: 1_000,
            cacheWriteTokens: 150,
            cacheReadTokens: 300,
            outputTokens: 250,
            totalTokens: 1_700,
          },
        ],
        models: [{ name: "claude-opus-4-8", totalTokens: 1_700 }],
        categories: [{ name: "Claude API", amount: 12.34 }],
      },
    });
    for (const [input, init] of fetchFn.mock.calls) {
      const url = requestUrl(input);
      expect(url.searchParams.get("bucket_width")).toBe("1d");
      expect((init as RequestInit).headers).toMatchObject({
        "anthropic-version": "2023-06-01",
        "x-api-key": "sk-ant-admin-test",
      });
    }
  });

  it("uses explicit Admin API credentials before Claude OAuth", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-explicit" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => "sk-ant-oat01-fallback",
      resolveOAuthToken: async () => ({ token: "oauth-token" }),
    });
    expect(result).toEqual({
      token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-explicit"}',
    });
  });

  it("auto-detects an Admin API key stored in the Anthropic provider profile", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => "sk-ant-admin-profile",
      resolveOAuthToken: async () => null,
    });
    expect(result).toEqual({
      token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-profile"}',
    });
  });

  it("prefers a stored Admin API key when normal API and OAuth credentials coexist", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => "sk-ant-api03-inference",
      resolveApiKeyCandidatesFromConfigAndStore: async () => [
        "sk-ant-api03-inference",
        "sk-ant-admin-billing",
      ],
      resolveOAuthToken: async () => ({ token: "oauth-token" }),
    });
    expect(result).toEqual({
      token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-billing"}',
    });
  });

  it("falls back to the synced claude-cli OAuth profile when anthropic has none", async () => {
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "claude-cli" ? { token: "claude-cli-token" } : null,
    );
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken,
    });
    expect(result).toEqual({ token: "claude-cli-token" });
    expect(resolveOAuthToken).toHaveBeenNthCalledWith(1);
    expect(resolveOAuthToken).toHaveBeenNthCalledWith(2, { provider: "claude-cli" });
  });

  it.each([
    { subscription: "max", tier: "default_max_20x", expected: "Max (20x)" },
    { subscription: "pro", tier: undefined, expected: "Pro" },
    { subscription: "max", tier: "default", expected: "Max" },
    { subscription: undefined, tier: "default_max_20x", expected: undefined },
    { subscription: "  ", tier: undefined, expected: undefined },
  ])("formats plan label for $subscription/$tier", ({ subscription, tier, expected }) => {
    expect(formatClaudePlanLabel(subscription, tier)).toBe(expected);
  });

  it("prefers plan metadata from the resolved auth profile over CLI reads", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: "oauth-token",
      subscriptionType: "pro",
      rateLimitTier: "default_pro",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.plan).toBe("Pro");
  });

  it("labels OAuth usage snapshots with the local Claude CLI plan", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 22, resets_at: "2026-07-09T18:00:00Z" },
            seven_day: { utilization: 25 },
          }),
          { status: 200 },
        ),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: "oauth-token",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.plan).toBe("Max (20x)");
    expect(snapshot.windows).toHaveLength(2);
  });

  it("does not attach a plan label when usage has no windows", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: "oauth-token",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.plan).toBeUndefined();
  });
});
