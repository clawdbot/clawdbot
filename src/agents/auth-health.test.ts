/**
 * Tests auth health rollups.
 * Covers OAuth/API-key status classification, external CLI bootstrap, provider
 * auth ordering, and prompt-free credential checks.
 */
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "./auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "./provider-auth-aliases.js";

const { resolveProviderIdForAuthMock } = vi.hoisted(() => ({
  resolveProviderIdForAuthMock: vi.fn<(provider: string, params?: unknown) => string>(
    (provider: string) => (provider === "codex-cli" ? "openai" : provider),
  ),
}));

vi.mock("./cli-credentials.js", () => ({
  readMiniMaxCliCredentialsCached: () => null,
}));
vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: resolveProviderIdForAuthMock,
}));

import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));
  const profileReasonCodes = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.reasonCode]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    resolveProviderIdForAuthMock.mockReset();
    resolveProviderIdForAuthMock.mockImplementation((provider: string) =>
      provider === "codex-cli" ? "openai" : provider,
    );
  });

  it("classifies OAuth and API key profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "anthropic:ok": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
        "anthropic:expiring": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + 10_000,
        },
        "anthropic:expired": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now - 10_000,
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["anthropic:ok"]).toBe("ok");
    expect(statuses["anthropic:expiring"]).toBe("expiring");
    expect(statuses["anthropic:expired"]).toBe("expired");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("expired");
    expect(
      provider?.profiles.find((profile) => profile.profileId === "anthropic:expired")?.status,
    ).toBe("expired");
  });

  it("classifies an API-key profile with an unmaterialized SecretRef as unavailable", () => {
    const summary = buildAuthHealthSummary({
      store: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    });

    expect(summary.profiles[0]).toMatchObject({
      profileId: "openai:default",
      status: "missing",
      reasonCode: "unresolved_ref",
      secretRef: { source: "env", id: "OPENAI_API_KEY" },
    });
    expect(summary.providers[0]?.status).toBe("missing");
  });

  it("uses ordered usable profiles for provider health while keeping stale inventory visible", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "stale-access",
          refresh: "stale-refresh",
          expires: now - 10_000,
        },
        "openai:named": {
          type: "oauth" as const,
          provider: "openai",
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
      },
      order: {
        openai: ["openai:named"],
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    expect(profileStatuses(summary)).toEqual({
      "openai:default": "expired",
      "openai:named": "ok",
    });
    const provider = summary.providers.find((entry) => entry.provider === "openai");
    expect(provider?.status).toBe("ok");
    expect(provider?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
    expect(provider?.effectiveProfiles?.map((profile) => profile.profileId)).toEqual([
      "openai:named",
    ]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual([
      "openai:default",
      "openai:named",
    ]);
  });

  it("honors canonical empty auth order for aliased stored profile providers", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "codex-cli:legacy": {
          type: "oauth" as const,
          provider: "codex-cli",
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
      },
      order: {
        openai: [],
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const provider = summary.providers.find((entry) => entry.provider === "codex-cli");
    expect(provider?.status).toBe("missing");
    expect(provider?.effectiveProfiles).toEqual([]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual(["codex-cli:legacy"]);
  });

  it("reports expired for OAuth without a refresh token", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "google:no-refresh": {
          type: "oauth" as const,
          provider: "google-antigravity",
          access: "access",
          refresh: "",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["google:no-refresh"]).toBe("expired");
  });

  it("reports command-shaped API-key profiles as missing malformed auth", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "zai:default": {
          type: "api_key" as const,
          provider: "zai",
          key: "openclaw onboard --auth-choice zai-coding-global",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    expect(profileStatuses(summary)["zai:default"]).toBe("missing");
    expect(profileReasonCodes(summary)["zai:default"]).toBe("malformed_api_key");
    expect(summary.providers.find((entry) => entry.provider === "zai")?.status).toBe("missing");
  });

  it("uses runtime provider credentials for profile health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "stale-access",
          refresh: "stale-refresh",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      runtimeCredentialsByProvider: new Map([
        [
          "claude-cli",
          {
            type: "token",
            provider: "claude-cli",
            token: "fresh-cli-access",
            expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
          },
        ],
      ]),
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "anthropic:claude-cli");
    expect(profile?.status).toBe("ok");
    expect(profile?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
  });

  it("marks oauth as expiring when it falls within the shared refresh margin", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "near-expiry-access",
          refresh: "near-expiry-refresh",
          expires: now + 2 * 60_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: 60_000,
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "openai:default");
    expect(profile?.status).toBe("expiring");
  });

  it("marks token profiles with invalid expires as missing with reason code", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "github-copilot:invalid-expires": {
          type: "token" as const,
          provider: "github-copilot",
          token: "gh-token",
          expires: 0,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    const statuses = profileStatuses(summary);
    const reasonCodes = profileReasonCodes(summary);

    expect(statuses["github-copilot:invalid-expires"]).toBe("missing");
    expect(reasonCodes["github-copilot:invalid-expires"]).toBe("invalid_expires");
  });

  it("does not expose out-of-range oauth expiry values in health rollups", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai:bad-expiry": {
          type: "oauth" as const,
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: MAX_DATE_TIMESTAMP_MS + 1,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "openai:bad-expiry");
    const provider = summary.providers.find((entry) => entry.provider === "openai");

    expect(profile?.status).toBe("missing");
    expect(profile?.expiresAt).toBeUndefined();
    expect(provider?.status).toBe("missing");
    expect(provider?.expiresAt).toBeUndefined();
  });

  it("keeps unavailable profiles in explicit auth order authoritative", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "claude-cli:token": {
          type: "token" as const,
          provider: "claude-cli",
          token: "fake-token",
        },
      },
    };
    const cfg = {
      auth: {
        order: {
          "claude-cli": ["claude-cli:old-oauth"],
        },
      },
    };

    const summary = buildAuthHealthSummary({ cfg, store });

    const provider = summary.providers.find((entry) => entry.provider === "claude-cli");
    expect(provider?.status).toBe("missing");
    expect(provider?.effectiveProfiles).toEqual([]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual(["claude-cli:token"]);
  });

  it("does not normalize provider aliases when filtering and grouping profile health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "zai:dot": {
          type: "api_key" as const,
          provider: "z.ai",
          key: "sk-dot",
        },
        "zai:dash": {
          type: "api_key" as const,
          provider: "z-ai",
          key: "sk-dash",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      providers: ["zai"],
    });

    expect(summary.profiles).toEqual([]);
    expect(summary.providers).toEqual([
      {
        provider: "zai",
        status: "missing",
        effectiveProfiles: [],
        profiles: [],
      },
    ]);
  });

  it("uses caller-owned plugin metadata when resolving explicit auth order", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    resolveProviderIdForAuthMock.mockImplementation((provider: string, params?: unknown) => {
      const metadata = (params as { metadataSnapshot?: { plugins?: unknown[] } } | undefined)
        ?.metadataSnapshot;
      return provider === "fixture-alias" && metadata?.plugins?.length
        ? "fixture-provider"
        : provider;
    });
    const metadataSnapshot = {
      plugins: [
        {
          id: "fixture-auth-alias",
          origin: "bundled" as const,
          providerAuthAliases: { "fixture-alias": "fixture-provider" },
        },
      ],
    } as unknown as NonNullable<ProviderAuthAliasLookupParams["metadataSnapshot"]>;
    const summary = buildAuthHealthSummary({
      cfg: { auth: { order: { "fixture-provider": [] } } },
      store: {
        version: 1,
        profiles: {
          "fixture-alias:token": {
            type: "token",
            provider: "fixture-alias",
            token: "fake-token",
          },
        },
      },
      authAliasLookupParams: {
        metadataSnapshot,
      },
    });

    expect(summary.providers).toMatchObject([
      { provider: "fixture-alias", status: "missing", effectiveProfiles: [] },
    ]);
    expect(resolveProviderIdForAuthMock).toHaveBeenCalledWith(
      "fixture-alias",
      expect.objectContaining({ metadataSnapshot }),
    );
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
