// Verifies provider usage telemetry preserves plugin auth context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);
const hasAnyAuthProfileStoreSourceMock = vi.fn(() => false);
const ensureAuthProfileStoreMock = vi.fn(() => ({
  profiles: {},
}));
const ensureAuthProfileStoreWithoutExternalProfilesMock = vi.fn(() => ({
  profiles: {},
}));
const resolveAuthProfileOrderMock = vi.fn((_params: unknown): string[] => []);
const resolveApiKeyForProfileMock = vi.fn(
  async (..._args: unknown[]): Promise<{ apiKey: string; provider: string } | null> => null,
);

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  ensureAuthProfileStore: () => ensureAuthProfileStoreMock(),
  ensureAuthProfileStoreWithoutExternalProfiles: () =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(),
  hasAnyAuthProfileStoreSource: () => hasAnyAuthProfileStoreSourceMock(),
  listProfilesForProvider: () => [],
  resolveApiKeyForProfile: (...args: unknown[]) => resolveApiKeyForProfileMock(...args),
  resolveAuthProfileOrder: (params: unknown) => resolveAuthProfileOrderMock(params),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({
    plugins: [
      {
        id: "minimax",
        origin: "bundled",
        providers: ["minimax", "minimax-portal"],
      },
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerUsageAuthEnvVars: {
          openai: ["OPENAI_ADMIN_KEY"],
        },
      },
    ],
  }),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNames: () => [
    "ANTHROPIC_API_KEY",
    "MINIMAX_CODE_PLAN_KEY",
    "OPENAI_API_KEY",
  ],
  resolveProviderAuthEnvVarCandidates: () => ({
    anthropic: ["ANTHROPIC_API_KEY"],
    minimax: ["MINIMAX_CODE_PLAN_KEY"],
    openai: ["OPENAI_API_KEY"],
  }),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {
      anthropic: ["ANTHROPIC_API_KEY"],
      minimax: ["MINIMAX_CODE_PLAN_KEY"],
      openai: ["OPENAI_API_KEY"],
    },
    authEvidenceMap: {},
  }),
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;
let resolveProviderAuthProfile: typeof import("./provider-usage.auth.js").resolveProviderAuthProfile;

function resolveProviderAuthsForTest(
  params: Parameters<typeof resolveProviderAuths>[0],
): ReturnType<typeof resolveProviderAuths> {
  return resolveProviderAuths({
    config: {},
    ...params,
  });
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-usage-"));
  try {
    return await fn(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function providerCalls(mockFn: { mock: { calls: unknown[][] } }): unknown[] {
  return mockFn.mock.calls.map(([params]) =>
    params && typeof params === "object" && "provider" in params
      ? (params as { provider?: unknown }).provider
      : undefined,
  );
}

describe("resolveProviderAuths plugin boundary", () => {
  beforeAll(async () => {
    ({ resolveProviderAuthProfile, resolveProviderAuths } =
      await import("./provider-usage.auth.js"));
  });

  beforeEach(() => {
    hasAnyAuthProfileStoreSourceMock.mockReset();
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockClear();
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {},
    });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockClear();
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {},
    });
    resolveAuthProfileOrderMock.mockReset();
    resolveAuthProfileOrderMock.mockReturnValue([]);
    resolveApiKeyForProfileMock.mockReset();
    resolveApiKeyForProfileMock.mockResolvedValue(null);
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
  });

  it("prefers plugin-owned usage auth when available", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-zai-token",
    });

    await expect(
      resolveProviderAuthsForTest({
        providers: ["zai"],
      }),
    ).resolves.toEqual([
      {
        provider: "zai",
        token: "plugin-zai-token",
      },
    ]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("resolves SecretRef-backed profiles before provider credential classification", async () => {
    const store = {
      profiles: {
        "anthropic:admin": {
          type: "api_key",
          provider: "anthropic",
          keyRef: { source: "env", id: "ANTHROPIC_ADMIN_KEY" },
        },
      },
    };
    ensureAuthProfileStoreMock.mockReturnValue(store as never);
    resolveAuthProfileOrderMock.mockReturnValue(["anthropic:admin"]);
    resolveApiKeyForProfileMock.mockResolvedValue({
      apiKey: "sk-ant-admin-secretref",
      provider: "anthropic",
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: {
          resolveApiKeyCandidatesFromConfigAndStore?: (params?: {
            providerIds?: string[];
          }) => Promise<string[]>;
        };
      };
      const candidates =
        (await params.context.resolveApiKeyCandidatesFromConfigAndStore?.({
          providerIds: ["anthropic"],
        })) ?? [];
      expect(candidates).toEqual(["sk-ant-admin-secretref"]);
      return candidates[0] ? { token: candidates[0] } : null;
    });

    const result = await resolveProviderAuthsForTest({
      providers: ["anthropic"],
      agentDir: "/tmp/openclaw-agent",
    });
    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledOnce();
    expect(resolveAuthProfileOrderMock).toHaveBeenCalled();
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith({
      cfg: {},
      store,
      profileId: "anthropic:admin",
      agentDir: "/tmp/openclaw-agent",
    });
    expect(result).toEqual([
      {
        provider: "anthropic",
        token: "sk-ant-admin-secretref",
      },
    ]);
  });

  it("does not synthesize Codex app-server auth for generic OpenAI usage", async () => {
    await expect(
      resolveProviderAuthsForTest({
        providers: ["openai"],
      }),
    ).resolves.toEqual([]);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["openai"]);
  });

  it("skips plugin usage auth when requested and no direct credential source exists", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toStrictEqual([]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps auth-profile credential sources provider-specific", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    });
    resolveAuthProfileOrderMock.mockImplementation((params: unknown) => {
      const provider =
        params && typeof params === "object" && "provider" in params
          ? (params as { provider?: unknown }).provider
          : undefined;
      return provider === "anthropic" ? ["anthropic:default"] : [];
    });
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-anthropic-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic", "zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([
        {
          provider: "anthropic",
          token: "plugin-anthropic-token",
        },
      ]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledTimes(1);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["anthropic"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps plugin usage auth when an owned alias provider has auth-profile credentials", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "minimax-portal:default": {
          type: "oauth",
          provider: "minimax-portal",
          accessToken: "portal-oauth-token",
        },
      },
    });
    resolveAuthProfileOrderMock.mockImplementation((params: unknown) => {
      const provider =
        params && typeof params === "object" && "provider" in params
          ? (params as { provider?: unknown }).provider
          : undefined;
      return provider === "minimax-portal" ? ["minimax-portal:default"] : [];
    });
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-minimax-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["minimax"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([
        {
          provider: "minimax",
          token: "plugin-minimax-token",
        },
      ]);
    });

    expect(providerCalls(resolveAuthProfileOrderMock)).toEqual(["minimax", "minimax-portal"]);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["minimax"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps plugin usage auth when provider-owned usage env credentials exist", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-minimax-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["minimax"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            MINIMAX_CODE_PLAN_KEY: "code-plan-key",
          },
        }),
      ).resolves.toEqual([
        {
          provider: "minimax",
          token: "plugin-minimax-token",
        },
      ]);
    });

    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["minimax"]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("lets an OAuth-default provider route an API key through its billing hook", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "encoded-openai-admin-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["openai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            OPENAI_API_KEY: "sk-admin-test",
          },
        }),
      ).resolves.toEqual([
        {
          provider: "openai",
          token: "encoded-openai-admin-token",
        },
      ]);
    });

    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["openai"]);
  });

  it("detects provider-owned usage credentials without routing them into inference auth", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "encoded-openai-admin-token",
    });

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["openai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            OPENAI_ADMIN_KEY: "sk-admin-test",
          },
        }),
      ).resolves.toEqual([
        {
          provider: "openai",
          token: "encoded-openai-admin-token",
        },
      ]);
    });

    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["openai"]);
  });

  it("does not overlay external auth profiles while checking the skip gate", async () => {
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toStrictEqual([]);
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledTimes(1);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
  });

  it("resolves only the requested profile without refresh or external overlays", async () => {
    const store = {
      version: 1,
      profiles: {
        "zai:work": {
          type: "api_key",
          provider: "zai",
          keyRef: { source: "env", provider: "default", id: "ZAI_API_KEY" },
        },
        "zai:fallback": {
          type: "api_key",
          provider: "zai",
          key: "fallback-key",
        },
      },
    };
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(store);
    resolveApiKeyForProfileMock.mockResolvedValueOnce({
      apiKey: "materialized-zai-key",
      provider: "zai",
    });

    await expect(
      resolveProviderAuthProfile({
        provider: "zai",
        authProfileId: "zai:work",
        config: {},
      }),
    ).resolves.toEqual({
      provider: "zai",
      token: "materialized-zai-key",
      authProfileId: "zai:work",
      credentialType: "api_key",
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledTimes(1);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        profileId: "zai:work",
        allowRefresh: false,
      }),
    );
    expect(resolveAuthProfileOrderMock).not.toHaveBeenCalled();
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
  });

  it.each([
    { storedProvider: "claude-cli", requestedProvider: "anthropic" },
    { storedProvider: "minimax-portal", requestedProvider: "minimax" },
  ])(
    "accepts $storedProvider exact profiles for canonical $requestedProvider usage",
    async ({ storedProvider, requestedProvider }) => {
      const profileId = `${storedProvider}:work`;
      ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: storedProvider,
            access: "profile-access",
            refresh: "profile-refresh",
            expires: Date.now() + 60_000,
          },
        },
      });
      resolveApiKeyForProfileMock.mockResolvedValueOnce({
        apiKey: "profile-access",
        provider: storedProvider,
      });

      await expect(
        resolveProviderAuthProfile({
          provider: requestedProvider,
          authProfileId: profileId,
          config: {},
        }),
      ).resolves.toEqual({
        provider: requestedProvider,
        token: "profile-access",
        authProfileId: profileId,
        credentialType: "oauth",
      });
      expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
        expect.objectContaining({ profileId, allowRefresh: false }),
      );
    },
  );

  it("fails closed when the requested profile belongs to another provider", async () => {
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "shared:profile": {
          type: "oauth",
          provider: "openai",
          access: "openai-access",
          refresh: "openai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    await expect(
      resolveProviderAuthProfile({
        provider: "zai",
        authProfileId: "shared:profile",
        config: {},
      }),
    ).resolves.toBeNull();
    expect(resolveApiKeyForProfileMock).not.toHaveBeenCalled();
    expect(resolveAuthProfileOrderMock).not.toHaveBeenCalled();
  });

  it("does not fall back when the requested profile is missing", async () => {
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      profiles: {
        "zai:fallback": {
          type: "api_key",
          provider: "zai",
          key: "fallback-key",
        },
      },
    });

    await expect(
      resolveProviderAuthProfile({
        provider: "zai",
        authProfileId: "zai:missing",
        config: {},
      }),
    ).resolves.toBeNull();
    expect(resolveApiKeyForProfileMock).not.toHaveBeenCalled();
    expect(resolveAuthProfileOrderMock).not.toHaveBeenCalled();
  });

  it("does not fall back to standard Anthropic API keys for usage auth", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({ handled: true });
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic", "zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            ANTHROPIC_API_KEY: "sk-ant-api03-status-key", // pragma: allowlist secret
          },
        }),
      ).resolves.toEqual([]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledTimes(1);
    expect(providerCalls(resolveProviderUsageAuthWithPluginMock)).toEqual(["anthropic"]);
  });
});
