import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  buildAuthHealthSummary: vi.fn(
    (): AuthHealthSummary => ({ now: 0, warnAfterMs: 0, profiles: [], providers: [] }),
  ),
  loadProviderUsageSummary: vi.fn(async () => ({ updatedAt: 0, providers: [] })),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));

vi.mock("../../agents/auth-health.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
    "../../agents/auth-health.js",
  );
  return {
    ...actual,
    buildAuthHealthSummary: mocks.buildAuthHealthSummary,
  };
});

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

import {
  aggregateOAuthStatus,
  invalidateModelAuthStatusCache,
  modelsAuthStatusHandlers,
  type ModelAuthStatusResult,
} from "./models-auth-status.js";

function createOptions(
  params: Record<string, unknown> = {},
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn();
  return {
    req: { type: "req", id: "req-1", method: "models.authStatus", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as unknown,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

const handler = modelsAuthStatusHandlers["models.authStatus"];

describe("models.authStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateModelAuthStatusCache();
    mocks.loadConfig.mockReturnValue({});
    mocks.ensureAuthProfileStore.mockReturnValue({ profiles: {} });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [],
    });
    mocks.loadProviderUsageSummary.mockResolvedValue({ updatedAt: 0, providers: [] });
  });

  it("returns a serialisable snapshot on first call", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [
        {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          type: "oauth",
          status: "ok",
          expiresAt: 1_000_000,
          remainingMs: 60_000,
          source: "store",
          label: "openai-codex:default",
        },
      ],
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          expiresAt: 1_000_000,
          remainingMs: 60_000,
          profiles: [
            {
              profileId: "openai-codex:default",
              provider: "openai-codex",
              type: "oauth",
              status: "ok",
              expiresAt: 1_000_000,
              remainingMs: 60_000,
              source: "store",
              label: "openai-codex:default",
            },
          ],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);

    expect(opts.respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = opts.respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = payload as ModelAuthStatusResult;
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe("openai-codex");
    expect(result.providers[0].status).toBe("ok");
    expect(result.providers[0].expiry?.at).toBe(1_000_000);
    expect(result.providers[0].profiles[0].type).toBe("oauth");
  });

  it("serves cached response within TTL and marks it as cached", async () => {
    const opts1 = createOptions();
    await handler(opts1);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const opts2 = createOptions();
    await handler(opts2);

    // Auth health should NOT be re-queried on the cached call.
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const lastCall = opts2.respond.mock.calls.at(-1);
    expect(lastCall?.[3]).toEqual(expect.objectContaining({ cached: true }));
  });

  it("bypasses cache when params.refresh is set", async () => {
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    await handler(createOptions({ refresh: true }));
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("invalidateModelAuthStatusCache() clears the cached response", async () => {
    await handler(createOptions());
    invalidateModelAuthStatusCache();
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("does not query usage for api-key-only providers", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [
        {
          profileId: "anthropic:default",
          provider: "anthropic",
          type: "api_key",
          status: "static",
          source: "store",
          label: "anthropic:default",
        },
      ],
      providers: [
        {
          provider: "anthropic",
          status: "static",
          profiles: [
            {
              profileId: "anthropic:default",
              provider: "anthropic",
              type: "api_key",
              status: "static",
              source: "store",
              label: "anthropic:default",
            },
          ],
        },
      ],
    });

    await handler(createOptions());
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
  });

  it("still returns providers when usage fetch fails", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [
        {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          type: "oauth",
          status: "ok",
          expiresAt: 1_000_000,
          remainingMs: 60_000,
          source: "store",
          label: "openai-codex:default",
        },
      ],
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          expiresAt: 1_000_000,
          remainingMs: 60_000,
          profiles: [
            {
              profileId: "openai-codex:default",
              provider: "openai-codex",
              type: "oauth",
              status: "ok",
              expiresAt: 1_000_000,
              remainingMs: 60_000,
              source: "store",
              label: "openai-codex:default",
            },
          ],
        },
      ],
    });
    mocks.loadProviderUsageSummary.mockRejectedValue(new Error("timeout"));

    const opts = createOptions();
    await handler(opts);

    const [ok, payload] = opts.respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    const result = payload as ModelAuthStatusResult;
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].usage).toBeUndefined();
  });

  it("does not leak secret-looking fields from upstream profile data", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [
        {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          type: "oauth",
          status: "ok",
          expiresAt: 1,
          remainingMs: 1,
          source: "store",
          label: "openai-codex:default",
          // Simulate a future profile shape that includes an access token —
          // the handler must NOT forward this, since it field-maps explicitly.
          access: "sk-SECRET-TOKEN",
          refresh: "rt-SECRET-REFRESH",
        } as never,
      ],
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          expiresAt: 1,
          remainingMs: 1,
          profiles: [
            {
              profileId: "openai-codex:default",
              provider: "openai-codex",
              type: "oauth",
              status: "ok",
              expiresAt: 1,
              remainingMs: 1,
              source: "store",
              label: "openai-codex:default",
              access: "sk-SECRET-TOKEN",
              refresh: "rt-SECRET-REFRESH",
            } as never,
          ],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);
    const [, payload] = opts.respond.mock.calls[0] ?? [];
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("sk-SECRET-TOKEN");
    expect(serialised).not.toContain("rt-SECRET-REFRESH");
  });

  it("skips env-backed OAuth providers (apiKey set in config) from missing synthesis", async () => {
    // Provider configured `auth: "oauth"` with `apiKey` present (env-backed)
    // must not be forwarded to buildAuthHealthSummary — doing so would flag
    // it as missing even though env auth already satisfies it.
    mocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "openai-codex": { auth: "oauth", apiKey: { env: "OPENAI_OAUTH_TOKEN" } },
        },
      },
    });
    await handler(createOptions());
    // When the only configured provider is env-backed, we pass `undefined`
    // (meaning "no filter"), not a filter containing it.
    const call = mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
      | [{ providers?: string[] }]
      | undefined;
    expect(call?.[0]?.providers).toBeUndefined();
  });

  it("flags provider configured auth:oauth but with only api_key profile as missing", async () => {
    // Config says provider should use OAuth; store has only an api_key
    // credential (e.g. operator switched modes but forgot to login).
    mocks.loadConfig.mockReturnValue({
      models: { providers: { anthropic: { auth: "oauth" } } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [
        {
          provider: "anthropic",
          status: "static",
          profiles: [
            {
              profileId: "anthropic:default",
              provider: "anthropic",
              type: "api_key",
              status: "static",
              source: "store",
              label: "anthropic:default",
            },
          ],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);
    const [, payload] = opts.respond.mock.calls[0] ?? [];
    const result = payload as ModelAuthStatusResult;
    expect(result.providers[0]?.status).toBe("missing");
  });

  it("responds with UNAVAILABLE when buildAuthHealthSummary throws", async () => {
    mocks.buildAuthHealthSummary.mockImplementation(() => {
      throw new Error("boom");
    });

    const opts = createOptions();
    await handler(opts);
    const [ok, payload, error] = opts.respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual(expect.objectContaining({ code: expect.stringMatching(/unavailable/i) }));
  });
});

// Direct unit tests for aggregateOAuthStatus — this helper was introduced to
// prevent a specific regression (mixed OAuth+token rollup mis-reporting
// providers). Pinning its behavior here so refactors can't silently re-break
// the same bug.
describe("aggregateOAuthStatus", () => {
  const NOW = 1_000_000;
  const expiring = NOW + 60_000; // 1 min in future

  function oauth(status: "ok" | "expiring" | "expired" | "missing", expiresAt?: number) {
    return {
      profileId: `p-${status}`,
      provider: "openai-codex",
      type: "oauth" as const,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store" as const,
      label: `p-${status}`,
    };
  }

  function token(status: "ok" | "expired") {
    return {
      profileId: `t-${status}`,
      provider: "openai-codex",
      type: "token" as const,
      status,
      expiresAt: status === "expired" ? NOW - 1 : undefined,
      remainingMs: status === "expired" ? -1 : undefined,
      source: "store" as const,
      label: `t-${status}`,
    };
  }

  it("ignores token profiles — healthy OAuth + expired token stays ok", () => {
    const result = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "expired",
        profiles: [oauth("ok", expiring + 10_000_000), token("expired")],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
  });

  it("falls back to prov.status when no OAuth profiles exist", () => {
    const result = aggregateOAuthStatus(
      {
        provider: "anthropic",
        status: "static",
        profiles: [
          {
            profileId: "anthropic:default",
            provider: "anthropic",
            type: "api_key",
            status: "static",
            source: "store",
            label: "anthropic:default",
          },
        ],
      },
      NOW,
    );
    expect(result.status).toBe("static");
  });

  it("expired + missing both map to 'expired'", () => {
    const expiredResult = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "expired",
        profiles: [oauth("expired", NOW - 1)],
      },
      NOW,
    );
    expect(expiredResult.status).toBe("expired");

    const missingResult = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "missing",
        profiles: [oauth("missing")],
      },
      NOW,
    );
    expect(missingResult.status).toBe("expired");
  });

  it("precedence: expired/missing > expiring > ok > static", () => {
    // expiring + ok → expiring (expired-marker absent)
    const res1 = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "expiring",
        profiles: [oauth("expiring", expiring), oauth("ok", expiring + 10_000_000)],
      },
      NOW,
    );
    expect(res1.status).toBe("expiring");

    // expired beats expiring
    const res2 = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "expired",
        profiles: [oauth("expired", NOW - 1), oauth("expiring", expiring)],
      },
      NOW,
    );
    expect(res2.status).toBe("expired");
  });

  it("picks the earliest expiresAt across OAuth profiles", () => {
    const earlier = NOW + 1_000;
    const later = NOW + 99_999;
    const result = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "ok",
        profiles: [oauth("ok", later), oauth("ok", earlier)],
      },
      NOW,
    );
    expect(result.expiresAt).toBe(earlier);
    expect(result.remainingMs).toBe(1_000);
  });
});
