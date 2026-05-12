import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveDefaultAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAuthProfileStore: vi.fn((agentDir?: string, options?: unknown) => {
    void agentDir;
    void options;
    return { profiles: {} };
  }),
  buildAuthHealthSummary: vi.fn(
    (): AuthHealthSummary => ({ now: 0, warnAfterMs: 0, profiles: [], providers: [] }),
  ),
  loadProviderUsageSummary: vi.fn(async () => ({ updatedAt: 0, providers: [] })),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  };
});

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
    context: { getRuntimeConfig: mocks.getRuntimeConfig } as unknown,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

const handler = modelsAuthStatusHandlers["models.authStatus"];

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function createOpenAiCodexOauthHealthSummary(): AuthHealthSummary {
  const profile = {
    profileId: "openai-codex:default",
    provider: "openai-codex",
    type: "oauth",
    status: "ok",
    expiresAt: 1_000_000,
    remainingMs: 60_000,
    source: "store",
    label: "openai-codex:default",
  } satisfies AuthHealthSummary["profiles"][number];
  return {
    now: 0,
    warnAfterMs: 0,
    profiles: [profile],
    providers: [
      {
        provider: "openai-codex",
        status: "ok",
        expiresAt: 1_000_000,
        remainingMs: 60_000,
        profiles: [profile],
      },
    ],
  };
}

describe("models.authStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateModelAuthStatusCache();
    mocks.getRuntimeConfig.mockReturnValue({});
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
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());

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
    expect(requireRecord(lastCall?.[3]).cached).toBe(true);
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

  it("scopes external CLI auth overlays to configured providers", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      auth: {
        profiles: {
          "opencode-go:default": { provider: "opencode-go", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "opencode-go/kimi-k2.6" },
        },
      },
      models: {
        providers: {
          "opencode-go": {
            baseUrl: "https://example.test/v1",
            auth: "api-key",
            models: [],
          },
        },
      },
    });

    await handler(createOptions());

    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAuthProfileStore.mock.calls[0]?.[0]).toBe("/tmp/agent");
    const [, options] = mocks.ensureAuthProfileStore.mock.calls[0] ?? [];
    const externalCli = requireRecord(requireRecord(options).externalCli);
    expect(externalCli.mode).toBe("scoped");
    expect(externalCli.allowKeychainPrompt).toBe(false);
    requireRecord(externalCli.config);
    expect(externalCli.providerIds).toContain("opencode-go");
    expect(externalCli.providerIds).not.toContain("claude-cli");
    expect(externalCli.profileIds).toEqual(["opencode-go:default"]);
  });

  it("disables external CLI auth overlays when config has no provider signal", async () => {
    await handler(createOptions());

    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAuthProfileStore.mock.calls[0]?.[0]).toBe("/tmp/agent");
    const [, options] = mocks.ensureAuthProfileStore.mock.calls[0] ?? [];
    const externalCli = requireRecord(requireRecord(options).externalCli);
    expect(externalCli.mode).toBe("none");
    expect(externalCli.allowKeychainPrompt).toBe(false);
    requireRecord(externalCli.config);
  });

  it("still returns providers when usage fetch fails", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
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

  it("skips env-backed OAuth providers (resolvable apiKey) from missing synthesis", async () => {
    // Provider configured `auth: "oauth"` with a resolvable apiKey — env
    // auth already satisfies it, so forwarding to buildAuthHealthSummary
    // would flag it as missing and cry wolf. Inline string is the simplest
    // "available" SecretInput for testing.
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          "openai-codex": { auth: "oauth", apiKey: "sk-xxxxx" },
        },
      },
    });
    await handler(createOptions());
    const call = mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
      | [{ providers?: string[] }]
      | undefined;
    expect(call?.[0]?.providers).toBeUndefined();
  });

  it("still flags provider as missing when apiKey env SecretRef points at an unset env var", async () => {
    // Config declares an env SecretRef but the referenced env var isn't
    // set. We read process.env directly for env-source SecretRefs and fall
    // through to the normal missing synthesis so the dashboard surfaces
    // the broken config instead of masking it.
    delete process.env.MODELS_AUTH_STATUS_TEST_MISSING_KEY;
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          "openai-codex": {
            auth: "oauth",
            apiKey: {
              source: "env",
              provider: "default",
              id: "MODELS_AUTH_STATUS_TEST_MISSING_KEY",
            },
          },
        },
      },
    });
    await handler(createOptions());
    const call = mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
      | [{ providers?: string[] }]
      | undefined;
    expect(call?.[0]?.providers).toEqual(["openai-codex"]);
  });

  it("env SecretRef pointing at a set env var is treated as env-backed", async () => {
    process.env.MODELS_AUTH_STATUS_TEST_SET_KEY = "sk-real-value";
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          "openai-codex": {
            auth: "oauth",
            apiKey: {
              source: "env",
              provider: "default",
              id: "MODELS_AUTH_STATUS_TEST_SET_KEY",
            },
          },
        },
      },
    });
    try {
      await handler(createOptions());
      const call = mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
        | [{ providers?: string[] }]
        | undefined;
      expect(call?.[0]?.providers).toBeUndefined();
    } finally {
      delete process.env.MODELS_AUTH_STATUS_TEST_SET_KEY;
    }
  });

  it("env-backed escape hatch also applies to auth.profiles entries", async () => {
    // auth.profiles loop must honor the env-backed skip from the
    // models.providers loop — otherwise a provider with resolvable apiKey
    // plus a matching auth.profiles entry re-adds itself and triggers the
    // false-missing alert we just fixed.
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          "openai-codex": { auth: "oauth", apiKey: "sk-xxxxx" },
        },
      },
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
    });
    await handler(createOptions());
    const call = mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
      | [{ providers?: string[] }]
      | undefined;
    expect(call?.[0]?.providers).toBeUndefined();
  });

  it("normalizes expectsOAuth provider ids to match buildAuthHealthSummary", async () => {
    // Config uses alias `z.ai`; buildAuthHealthSummary normalizes to `zai`.
    // Without normalization, expectsOAuth.has(prov.provider) fires on the
    // raw `z.ai` key but prov.provider is `zai`, so the "configured oauth
    // but no oauth profile" signal silently skipped the alias path.
    mocks.getRuntimeConfig.mockReturnValue({
      models: { providers: { "z.ai": { auth: "oauth" } } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [
        {
          provider: "zai",
          status: "static",
          profiles: [
            {
              profileId: "zai:default",
              provider: "zai",
              type: "api_key",
              status: "static",
              source: "store",
              label: "zai:default",
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

  it("flags provider configured auth:oauth but with only api_key profile as missing", async () => {
    // Config says provider should use OAuth; store has only an api_key
    // credential (e.g. operator switched modes but forgot to login).
    mocks.getRuntimeConfig.mockReturnValue({
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
    expect(String(requireRecord(error).code)).toMatch(/unavailable/i);
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

  it("uses effective OAuth profiles while keeping stale inventory visible", () => {
    const healthy = oauth("ok", expiring + 10_000_000);
    const stale = oauth("expired", NOW - 1);
    const result = aggregateOAuthStatus(
      {
        provider: "openai-codex",
        status: "ok",
        effectiveProfiles: [healthy],
        profiles: [stale, healthy],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.expiresAt).toBe(healthy.expiresAt);
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
