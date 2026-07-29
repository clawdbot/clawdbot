/**
 * Tests auth health rollups.
 * Covers OAuth/API-key status classification, external CLI bootstrap, provider
 * auth ordering, and prompt-free credential checks.
 */
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "./auth-profiles/types.js";

const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<
    (options?: { allowKeychainPrompt?: boolean }) => OAuthCredential | null
  >(() => null),
}));

vi.mock("./cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));
vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => (provider === "codex-cli" ? "openai" : provider),
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

  function mockFreshCodexCliCredentials() {
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "fresh-cli-access",
      refresh: "fresh-cli-refresh",
      expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
      accountId: "acct-cli",
    });
  }

  function buildOpenAiCodexOAuthStore(params: {
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  }) {
    return {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          ...params,
        },
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
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

  it("reports unresolved legacy Codex OAuth sidecars as missing auth", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFreshCodexCliCredentials();
    const store = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth" as const,
          provider: "openai-codex",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
          oauthRef: {
            source: "openclaw-credentials" as const,
            provider: "openai-codex" as const,
            id: "0123456789abcdef0123456789abcdef",
          },
        } as unknown as OAuthCredential,
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    expect(profileStatuses(summary)["openai-codex:default"]).toBe("missing");
    expect(profileReasonCodes(summary)["openai-codex:default"]).toBe("unresolved_ref");
    expect(summary.providers.find((entry) => entry.provider === "openai-codex")?.status).toBe(
      "missing",
    );
  });

  it("uses external CLI bootstrap before marking empty OAuth profiles missing", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFreshCodexCliCredentials();
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
        } as unknown as OAuthCredential,
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    expect(profileStatuses(summary)["openai:default"]).toBe("ok");
    expect(profileReasonCodes(summary)["openai:default"]).toBeUndefined();
    const provider = summary.providers.find((entry) => entry.provider === "openai");
    expect(provider?.status).toBe("ok");
    expect(provider?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowKeychainPrompt: false }),
    );
  });

  it("passes no-prompt policy to external CLI bootstrap during health checks", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFreshCodexCliCredentials();
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
        } as unknown as OAuthCredential,
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      allowKeychainPrompt: false,
    });

    expect(profileStatuses(summary)["openai:default"]).toBe("ok");
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowKeychainPrompt: false }),
    );
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

  it("does not let fresh .codex state override expired canonical health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFreshCodexCliCredentials();
    const store = buildOpenAiCodexOAuthStore({
      access: "expired-access",
      refresh: "expired-refresh",
      expires: now - 10_000,
      accountId: "acct-cli",
    });

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);
    expect(statuses["openai:default"]).toBe("expired");
  });

  it("keeps healthy local oauth over fresher imported Codex CLI credentials in health status", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "fresh-cli-access",
      refresh: "fresh-cli-refresh",
      expires: now + 7 * DEFAULT_OAUTH_WARN_MS,
      accountId: "acct-cli",
    });
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "healthy-local-access",
          refresh: "healthy-local-refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "openai:default");
    expect(profile?.status).toBe("ok");
    expect(profile?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 10_000);
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

  it("does not let fresh .codex state override near-expiry canonical health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFreshCodexCliCredentials();
    const store = buildOpenAiCodexOAuthStore({
      access: "near-expiry-local-access",
      refresh: "near-expiry-local-refresh",
      expires: now + 2 * 60_000,
    });

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: 60_000,
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "openai:default");
    expect(profile?.status).toBe("expiring");
    expect(profile?.expiresAt).toBe(now + 2 * 60_000);
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
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
