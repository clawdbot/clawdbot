import { CLAUDE_CLI_PROFILE_ID as SDK_CLAUDE_CLI_PROFILE_ID } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function oauthFixtureToken(): string {
  return ["oauth", "token"].join("-");
}

describe("Anthropic provider usage", () => {
  afterEach(() => vi.unstubAllEnvs());

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

    const auth = await resolveAnthropicUsageAuth({
      config: {},
      env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-test" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken: async () => null,
    });
    if (!("token" in auth) || !auth.token) {
      throw new Error("expected encoded Anthropic Admin API credentials");
    }
    const result = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: auth.token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result).toEqual({
      provider: "anthropic",
      displayName: "Anthropic",
      usageScope: "provider",
      windows: [],
      plan: "Admin API",
      billing: [
        {
          type: "spend",
          label: "30-day API spend",
          amount: 12.34,
          unit: "USD",
          period: "30d",
        },
      ],
      costHistory: {
        unit: "USD",
        periodDays: 30,
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
        models: [
          {
            name: "claude-opus-4-8",
            inputTokens: 1_000,
            cacheReadTokens: 300,
            cacheWriteTokens: 150,
            outputTokens: 250,
            totalTokens: 1_700,
          },
        ],
        categories: [{ name: "Claude API", amount: 12.34 }],
      },
      summary: "1,700 tokens",
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

  it("keeps rejected organization reports provider-scoped", async () => {
    const auth = await resolveAnthropicUsageAuth({
      config: {},
      env: { ANTHROPIC_ADMIN_API_KEY: "synthetic-admin-key" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken: async () => null,
    });
    if (!("token" in auth) || !auth.token) throw new Error("expected synthetic admin credential");
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: auth.token,
      timeoutMs: 5_000,
      fetchFn: vi.fn(async () => new Response("", { status: 403 })),
    });
    expect(snapshot).toMatchObject({
      usageScope: "provider",
      error: "Admin API key required",
      windows: [],
    });
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

  it("keeps exact-profile usage on the selected OAuth account", async () => {
    const resolveOAuthToken = vi.fn(async () => ({ token: "selected-oauth-token" }));
    const resolveCandidates = vi.fn(async () => ["sk-ant-admin-global"]);
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-global" },
      provider: "anthropic",
      authProfileId: "anthropic:selected",
      resolveApiKeyFromConfigAndStore: () => "sk-ant-admin-global",
      resolveApiKeyCandidatesFromConfigAndStore: resolveCandidates,
      resolveOAuthToken,
    });

    expect(result).toEqual({ token: "selected-oauth-token" });
    expect(resolveOAuthToken).toHaveBeenCalledOnce();
    expect(resolveCandidates).not.toHaveBeenCalled();
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

  it("keeps the local retired profile id aligned with the plugin-sdk constant", () => {
    expect(CLAUDE_CLI_PROFILE_ID).toBe(SDK_CLAUDE_CLI_PROFILE_ID);
  });

  it("does not refresh the native Claude login for usage polling", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken,
    });
    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledOnce();
    expect(resolveOAuthToken).toHaveBeenCalledWith({
      excludeProfileIds: ["anthropic:claude-cli"],
    });
  });

  it("uses plan metadata from the resolved auth profile", async () => {
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

  it("does not read Claude CLI auth to label OAuth usage", async () => {
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
    expect(snapshot.plan).toBeUndefined();
    expect(snapshot.windows).toHaveLength(2);
  });

  it("attaches the resolved credential email to OAuth usage snapshots", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: oauthFixtureToken(),
      email: "profile@example.com",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.accountEmail).toBe("profile@example.com");
  });

  it("leaves the account unlabeled when the credential carries no email", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: oauthFixtureToken(),
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.accountEmail).toBeUndefined();
    expect(snapshot.usageScope).toBe("account");
  });

  it("does not attribute ambient browser usage to a selected OAuth account", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-synthetic-other-account");
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/api/oauth/usage")) {
        return Response.json(
          { error: { message: "missing scope requirement user:profile" } },
          { status: 403 },
        );
      }
      if (url.pathname.endsWith("/api/organizations")) {
        return Response.json([{ uuid: "other-account" }]);
      }
      return Response.json({ five_hour: { utilization: 90 } });
    });
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: oauthFixtureToken(),
      authProfileId: "anthropic:selected",
      email: "selected@example.invalid",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.error).toBe("HTTP 403: missing scope requirement user:profile");
    expect(snapshot.usageScope).toBe("account");
    expect(snapshot.windows).toEqual([]);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${oauthFixtureToken()}`,
    );
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
