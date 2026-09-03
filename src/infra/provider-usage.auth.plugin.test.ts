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
    zai: ["ZAI_API_KEY"],
  }),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {
      anthropic: ["ANTHROPIC_API_KEY"],
      minimax: ["MINIMAX_CODE_PLAN_KEY"],
      openai: ["OPENAI_API_KEY"],
      zai: ["ZAI_API_KEY"],
    },
    authEvidenceMap: {},
  }),
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;

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
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
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

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["zai"],
          env: { HOME: homeDir, ZAI_API_KEY: "zai-env-key" },
        }),
      ).resolves.toEqual([
        {
          provider: "zai",
          token: "plugin-zai-token",
        },
      ]);
    });
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("preserves exact plugin auth failures for direct callers", async () => {
    const authError = new Error("plugin auth failed");
    resolveProviderUsageAuthWithPluginMock.mockRejectedValueOnce(authError);

    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic"],
          env: { HOME: homeDir, ANTHROPIC_API_KEY: "sk-ant-env" },
        }),
      ).rejects.toBe(authError);
    });
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
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(store as never);
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

  it("excludes native credential providers from plugin OAuth resolution", async () => {
    const store = {
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "native-access",
          refresh: "native-refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:managed": {
          type: "oauth",
          provider: "anthropic",
          access: "managed-access",
          refresh: "managed-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    ensureAuthProfileStoreMock.mockReturnValue(store as never);
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(true);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(store as never);
    resolveAuthProfileOrderMock.mockReturnValue(["anthropic:claude-cli", "anthropic:managed"]);
    resolveApiKeyForProfileMock.mockImplementation(async (params) => {
      const profileId = (params as { profileId: string }).profileId;
      return profileId === "anthropic:managed"
        ? { apiKey: "managed-access", provider: "anthropic" }
        : { apiKey: "native-access", provider: "claude-cli" };
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: {
          resolveOAuthToken: (options: {
            excludeProfileIds: string[];
          }) => Promise<{ token: string } | null>;
        };
      };
      return params.context.resolveOAuthToken({
        excludeProfileIds: ["anthropic:claude-cli"],
      });
    });

    await expect(resolveProviderAuthsForTest({ providers: ["anthropic"] })).resolves.toEqual([
      { provider: "anthropic", token: "managed-access" },
    ]);
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "anthropic:managed" }),
    );
  });

  it("does not synthesize Codex app-server auth for generic OpenAI usage", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["openai"],
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([]);
    });
    // The credential-source gate keeps credential-less providers off plugin runtime entirely.
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
  });

  it("skips plugin usage auth by default when no credential source exists", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["zai"],
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
          env: { HOME: homeDir },
        }),
      ).resolves.toStrictEqual([]);
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledTimes(1);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
  });

  it("uses a caller-provided auth store for credential gating", async () => {
    const store = {
      profiles: {
        "anthropic:external": {
          type: "oauth",
          provider: "anthropic",
          access: "external-access",
          refresh: "external-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    resolveAuthProfileOrderMock.mockReturnValue(["anthropic:external"]);
    resolveApiKeyForProfileMock.mockResolvedValue({
      apiKey: "external-access",
      provider: "anthropic",
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: { resolveOAuthToken: () => Promise<{ token: string } | null> };
      };
      return params.context.resolveOAuthToken();
    });

    await expect(
      resolveProviderAuthsForTest({
        providers: ["anthropic"],
        store: store as never,
      }),
    ).resolves.toEqual([{ provider: "anthropic", token: "external-access" }]);

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("resolves a caller-provided lazy auth store once for credential gating", async () => {
    const store = {
      profiles: {
        "anthropic:external": {
          type: "oauth",
          provider: "anthropic",
          access: "external-access",
          refresh: "external-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const getStore = vi.fn(() => store as never);
    resolveAuthProfileOrderMock.mockReturnValue(["anthropic:external"]);
    resolveApiKeyForProfileMock.mockResolvedValue({
      apiKey: "external-access",
      provider: "anthropic",
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: { resolveOAuthToken: () => Promise<{ token: string } | null> };
      };
      return params.context.resolveOAuthToken();
    });

    await expect(
      resolveProviderAuthsForTest({
        providers: ["anthropic"],
        getStore,
      }),
    ).resolves.toEqual([{ provider: "anthropic", token: "external-access" }]);

    expect(getStore).toHaveBeenCalledOnce();
    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("does not fall back to standard Anthropic API keys for usage auth", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({ handled: true });
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuthsForTest({
          providers: ["anthropic", "zai"],
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
