// Github Copilot tests cover auth plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const coerceSecretRefMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputWithFallbackMock = vi.hoisted(() => vi.fn());
const resolveRequiredConfiguredSecretRefInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const { findNormalizedProviderValue, resolveAuthProfileOrder } =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  const { normalizeOptionalString } = await import("openclaw/plugin-sdk/string-coerce-runtime");
  return {
    coerceSecretRef: coerceSecretRefMock,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    findNormalizedProviderValue,
    listProfilesForProvider: listProfilesForProviderMock,
    normalizeOptionalSecretInput: normalizeOptionalString,
    resolveAuthProfileOrder,
  };
});

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputWithFallback: resolveConfiguredSecretInputWithFallbackMock,
  resolveRequiredConfiguredSecretRefInputString: resolveRequiredConfiguredSecretRefInputStringMock,
}));

import { resolveFirstGithubToken } from "./auth.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/secret-input-runtime");
  vi.resetModules();
});

describe("resolveFirstGithubToken", () => {
  beforeEach(() => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": {
          type: "token",
          tokenRef: { source: "file", provider: "default", id: "/providers/github-copilot/token" },
        },
      },
    });
    listProfilesForProviderMock.mockReturnValue(["github-copilot:github"]);
    coerceSecretRefMock.mockImplementation((value: unknown) =>
      typeof value === "object" && value !== null && "source" in value ? value : null,
    );
    resolveRequiredConfiguredSecretRefInputStringMock.mockImplementation(
      async ({ value }: { value: unknown }) => (value ? "resolved-profile-token" : undefined),
    );
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      value: "test-token-placeholder",
      source: "config",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    coerceSecretRefMock.mockReset();
    resolveConfiguredSecretInputWithFallbackMock.mockReset();
    resolveRequiredConfiguredSecretRefInputStringMock.mockReset();
  });

  it("preserves ambient-token precedence when no configured SecretRef owns auth", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", token: "profile-token" },
      },
    });

    const result = await resolveFirstGithubToken({
      env: { GH_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "env-token",
      hasProfile: false,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("returns direct profile tokens when no SecretRef is configured", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": {
          type: "token",
          token: "profile-token",
        },
      },
    });
    const result = await resolveFirstGithubToken({
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "profile-token",
      hasProfile: true,
    });
  });

  it.each([
    {
      label: "configured order selects the second stored account",
      configuredOrder: ["github-copilot:preferred"],
      expectedToken: "preferred-token",
    },
    {
      label: "stored account order overrides configured order",
      configuredOrder: ["github-copilot:first"],
      storedOrder: ["github-copilot:preferred"],
      expectedToken: "preferred-token",
    },
    {
      label: "provider keys are matched case-insensitively",
      providerKey: " GITHUB-COPILOT ",
      configuredOrder: ["github-copilot:preferred"],
      expectedToken: "preferred-token",
    },
    {
      label: "an explicit empty order does not fall back to another account",
      configuredOrder: [],
      expectedToken: "",
    },
    {
      label: "a missing configured account does not fall back to another account",
      configuredOrder: ["github-copilot:missing"],
      expectedToken: "",
    },
    {
      label: "a cooled-down explicitly ordered account moves behind an available account",
      configuredOrder: ["github-copilot:first", "github-copilot:preferred"],
      firstAccountInCooldown: true,
      expectedToken: "preferred-token",
    },
  ])("honors auth profile order when $label", async (testCase) => {
    const providerKey = testCase.providerKey ?? "github-copilot";
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "first-token",
        },
        "github-copilot:preferred": {
          type: "token",
          provider: "github-copilot",
          token: "preferred-token",
        },
      },
      ...(testCase.storedOrder ? { order: { [providerKey]: testCase.storedOrder } } : {}),
      ...(testCase.firstAccountInCooldown
        ? {
            usageStats: {
              "github-copilot:first": { cooldownUntil: Date.now() + 60_000 },
            },
          }
        : {}),
    });
    listProfilesForProviderMock.mockReturnValue([
      "github-copilot:first",
      "github-copilot:preferred",
    ]);

    await expect(
      resolveFirstGithubToken({
        config: {
          auth: { order: { [providerKey]: testCase.configuredOrder } },
        },
        env: {},
      }),
    ).resolves.toEqual({ githubToken: testCase.expectedToken, hasProfile: true });
  });

  it.each([
    {
      label: "a public GitHub OAuth account",
      enterpriseUrl: undefined,
      expected: {
        githubToken: "durable-github-token",
        githubDomain: "github.com",
        hasProfile: true,
      },
    },
    {
      label: "an enterprise GitHub OAuth account",
      enterpriseUrl: "acme.ghe.com",
      expected: {
        githubToken: "durable-github-token",
        githubDomain: "acme.ghe.com",
        hasProfile: true,
      },
    },
    {
      label: "an OAuth account without a durable credential",
      enterpriseUrl: undefined,
      refresh: "",
      expected: { githubToken: "", hasProfile: true },
    },
    {
      label: "an OAuth account with a whitespace-only durable credential",
      enterpriseUrl: undefined,
      refresh: "   ",
      expected: { githubToken: "", hasProfile: true },
    },
    {
      label: "an enterprise OAuth account without a durable credential",
      enterpriseUrl: "acme.ghe.com",
      refresh: "",
      expected: { githubToken: "", hasProfile: true },
    },
    {
      label: "an enterprise OAuth account with a whitespace-only durable credential",
      enterpriseUrl: "acme.ghe.com",
      refresh: "   ",
      expected: { githubToken: "", hasProfile: true },
    },
  ])("uses the durable credential when explicit order selects $label", async (testCase) => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "first-token",
        },
        "github-copilot:preferred": {
          type: "oauth",
          provider: "github-copilot",
          access: "short-lived-copilot-token",
          refresh: testCase.refresh ?? " durable-github-token ",
          expires: Date.now() + 60_000,
          ...(testCase.enterpriseUrl ? { enterpriseUrl: testCase.enterpriseUrl } : {}),
        },
      },
    });
    listProfilesForProviderMock.mockReturnValue([
      "github-copilot:first",
      "github-copilot:preferred",
    ]);

    await expect(
      resolveFirstGithubToken({
        config: { auth: { order: { "github-copilot": ["github-copilot:preferred"] } } },
        env: {},
      }),
    ).resolves.toEqual(testCase.expected);
  });

  it.each(["durable-github-token", "", "   "])(
    "rejects an explicitly ordered OAuth account with an unsupported enterprise domain (refresh: %j)",
    async (refresh) => {
      ensureAuthProfileStoreMock.mockReturnValue({
        version: 1,
        profiles: {
          "github-copilot:preferred": {
            type: "oauth",
            provider: "github-copilot",
            access: "short-lived-copilot-token",
            refresh,
            expires: Date.now() + 60_000,
            enterpriseUrl: "attacker.example",
          },
        },
      });
      listProfilesForProviderMock.mockReturnValue(["github-copilot:preferred"]);

      await expect(
        resolveFirstGithubToken({
          config: { auth: { order: { "github-copilot": ["github-copilot:preferred"] } } },
          env: {},
        }),
      ).rejects.toThrow(/attacker\.example/);
    },
  );

  it("keeps the first stored account without an explicit order or cooldown mutation", async () => {
    const expiredCooldown = Date.now() - 60_000;
    const store = {
      version: 1,
      profiles: {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "first-token",
        },
        "github-copilot:preferred": {
          type: "token",
          provider: "github-copilot",
          token: "preferred-token",
        },
      },
      usageStats: {
        "github-copilot:first": { cooldownUntil: expiredCooldown },
      },
    };
    ensureAuthProfileStoreMock.mockReturnValue(store);
    listProfilesForProviderMock.mockReturnValue([
      "github-copilot:first",
      "github-copilot:preferred",
    ]);

    await expect(resolveFirstGithubToken({ config: {}, env: {} })).resolves.toEqual({
      githubToken: "first-token",
      hasProfile: true,
    });
    expect(store.usageStats["github-copilot:first"].cooldownUntil).toBe(expiredCooldown);
  });

  it("preserves explicitly requested profiles even when account order excludes them", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "first-token",
        },
        "github-copilot:preferred": {
          type: "token",
          provider: "github-copilot",
          token: "preferred-token",
        },
      },
    });
    listProfilesForProviderMock.mockReturnValue([
      "github-copilot:first",
      "github-copilot:preferred",
    ]);

    await expect(
      resolveFirstGithubToken({
        config: { auth: { order: { "github-copilot": ["github-copilot:first"] } } },
        env: {},
        profileId: "github-copilot:preferred",
      }),
    ).resolves.toEqual({ githubToken: "preferred-token", hasProfile: true });
  });

  it("uses environment direct auth without falling back to config or the first profile", async () => {
    const config = {
      models: {
        providers: {
          "github-copilot": { apiKey: "test-token-placeholder" },
        },
      },
    } as never;
    const env = { GH_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveFirstGithubToken({
      config,
      env,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-auth-token",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).not.toHaveBeenCalled();
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "api-key"] as const)(
    "does not fall back to ambient tokens when a direct apiKey SecretRef is unavailable (auth: %s)",
    async (auth) => {
      ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
      listProfilesForProviderMock.mockReturnValue([]);
      const config = {
        models: {
          providers: {
            "github-copilot": {
              ...(auth ? { auth } : {}),
              apiKey: {
                source: "env",
                provider: "default",
                id: "MISSING_COPILOT_DIRECT_TOKEN",
              },
              baseUrl: "https://api.githubcopilot.com",
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig;
      const env = {
        COPILOT_GITHUB_TOKEN: "ambient-copilot-token",
        GH_TOKEN: "ambient-gh-token",
        GITHUB_TOKEN: "ambient-github-token",
      };
      resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
        secretRefConfigured: true,
        unresolvedRefReason: "models.providers.github-copilot.apiKey SecretRef is unresolved.",
      });

      for (const authProfileMode of [undefined, "api_key"] as const) {
        await expect(
          resolveFirstGithubToken({ config, env, ...(authProfileMode ? { authProfileMode } : {}) }),
        ).rejects.toThrow("models.providers.github-copilot.apiKey");
      }
    },
  );

  it("resolves a configured direct SecretRef before a stored profile", async () => {
    const config = {
      models: {
        providers: {
          "github-copilot": {
            apiKey: {
              source: "env",
              provider: "default",
              id: "MISSING_COPILOT_DIRECT_TOKEN",
            },
          },
        },
      },
    } as never;
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      secretRefConfigured: true,
      unresolvedRefReason: "models.providers.github-copilot.apiKey SecretRef is unresolved.",
    });

    await expect(resolveFirstGithubToken({ config, env: {} })).rejects.toThrow(
      "models.providers.github-copilot.apiKey",
    );
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("lets explicit api-key config outrank environment direct auth", async () => {
    const config = {
      models: {
        providers: {
          "github-copilot": {
            auth: "api-key",
            apiKey: "test-token-placeholder",
          },
        },
      },
    } as never;
    const env = { GH_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveFirstGithubToken({
      config,
      env,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith({
      config,
      env,
      value: "test-token-placeholder",
      path: "models.providers.github-copilot.apiKey",
      readFallback: expect.any(Function),
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("ignores inactive apiKey refs for OAuth profiles and profile-less direct auth", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": {
          type: "token",
          token: "profile-token",
        },
      },
    });
    resolveRequiredConfiguredSecretRefInputStringMock.mockResolvedValue(undefined);
    const config = {
      models: {
        providers: {
          "github-copilot": {
            auth: "oauth",
            apiKey: {
              source: "env",
              provider: "default",
              id: "MISSING_COPILOT_DIRECT_TOKEN",
            },
          },
        },
      },
    } as never;

    await expect(
      resolveFirstGithubToken({
        config,
        env: { GH_TOKEN: "ambient-token" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ githubToken: "ambient-token", hasProfile: false });
    expect(resolveConfiguredSecretInputWithFallbackMock).not.toHaveBeenCalled();

    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
    listProfilesForProviderMock.mockReturnValue([]);
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({ secretRefConfigured: false });
    await expect(resolveFirstGithubToken({ config, env: {} })).resolves.toEqual({
      githubToken: "",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: undefined }),
    );
  });

  it("skips empty higher-priority environment variables", async () => {
    const result = await resolveFirstGithubToken({
      env: {
        COPILOT_GITHUB_TOKEN: "",
        GH_TOKEN: "test-auth-token",
      } as NodeJS.ProcessEnv,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-auth-token",
      hasProfile: false,
    });
  });

  it("resolves config-only direct auth for unscoped model discovery", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
    listProfilesForProviderMock.mockReturnValue([]);
    const config = {
      models: {
        providers: {
          "github-copilot": { apiKey: "test-token-placeholder" },
        },
      },
    } as never;

    const result = await resolveFirstGithubToken({
      config,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("does not report stored profiles for a missing direct credential", async () => {
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      secretRefConfigured: false,
    });

    const result = await resolveFirstGithubToken({
      config: {},
      env: {} as NodeJS.ProcessEnv,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "",
      hasProfile: false,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("never replaces an explicitly requested missing profile with ambient auth or another profile", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", token: "other-profile-token" },
      },
    });

    await expect(
      resolveFirstGithubToken({
        env: { GH_TOKEN: "ambient-token" },
        profileId: "github-copilot:missing",
      }),
    ).resolves.toEqual({ githubToken: "", hasProfile: true });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("does not read process.env or swallow an explicitly requested unavailable profile ref", async () => {
    const tokenRef = { source: "env", provider: "default", id: "COPILOT_PROCESS_ONLY_TOKEN" };
    vi.stubEnv(tokenRef.id, "process-only-token");
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", tokenRef },
        "github-copilot:other": { type: "token", token: "other-profile-token" },
      },
    });
    listProfilesForProviderMock.mockReturnValue(["github-copilot:github", "github-copilot:other"]);
    resolveRequiredConfiguredSecretRefInputStringMock.mockRejectedValue(
      new Error("github-copilot:github tokenRef unavailable"),
    );

    await expect(
      resolveFirstGithubToken({
        env: {},
        profileId: "github-copilot:github",
      }),
    ).rejects.toThrow("github-copilot:github tokenRef unavailable");
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, env: {}, value: tokenRef }),
    );
  });

  it("resolves a profile SecretRef before stale plaintext through the central resolver", async () => {
    const config = { secrets: { defaults: { provider: "default" } } } as never;
    const env = {} as NodeJS.ProcessEnv;
    const tokenRef = { source: "file", provider: "default", id: "/providers/github-copilot/token" };
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", token: "stale-profile-token", tokenRef },
      },
    });
    const result = await resolveFirstGithubToken({
      config,
      env,
    });

    expect(result).toEqual({
      githubToken: "resolved-profile-token",
      hasProfile: true,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith({
      config,
      env,
      value: tokenRef,
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
