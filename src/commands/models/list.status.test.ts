import { describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type MockAuthProfile = { provider: string; [key: string]: unknown };
  const store = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
        refresh: "sk-ant-ort01-REFRESH-TOKEN-1234567890", // pragma: allowlist secret
        expires: Date.now() + 60_000,
        email: "peter@example.com",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
      },
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "eyJhbGciOi-ACCESS",
        refresh: "oai-refresh-1234567890",
        expires: Date.now() + 60_000,
      },
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "abc123", // pragma: allowlist secret
      },
    } as Record<string, MockAuthProfile>,
  };

  return {
    store,
    resolveOpenClawAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveAgentExplicitModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    listProfilesForProvider: vi.fn((s: typeof store, provider: string) => {
      return Object.entries(s.profiles)
        .filter(([, cred]) => cred.provider === provider)
        .map(([id]) => id);
    }),
    resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
    resolveAuthStorePathForDisplay: vi
      .fn()
      .mockReturnValue("/tmp/openclaw-agent/auth-profiles.json"),
    resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(undefined),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      if (provider === "minimax") {
        return {
          apiKey: "sk-minimax-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "env: MINIMAX_API_KEY",
        };
      }
      if (provider === "fal") {
        return {
          apiKey: "fal_test_0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "env: FAL_KEY",
        };
      }
      return null;
    }),
    resolveProviderEnvApiKeyCandidates: vi.fn().mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      "openai-codex": ["OPENAI_OAUTH_TOKEN"],
      fal: ["FAL_KEY"],
    }),
    listKnownProviderEnvApiKeyNames: vi
      .fn()
      .mockReturnValue([
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "MINIMAX_API_KEY",
        "MINIMAX_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OPENAI_OAUTH_TOKEN",
        "FAL_KEY",
      ]),
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    resolveUsableCustomProviderApiKey: vi.fn().mockReturnValue(null),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    createConfigIO: vi.fn().mockReturnValue({
      configPath: "/tmp/openclaw-dev/openclaw.json",
    }),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
    loadProviderUsageSummary: vi.fn().mockResolvedValue(undefined),
    resolveRuntimeSyntheticAuthProviderRefs: vi.fn().mockReturnValue([]),
  };
});

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
  resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
  listAgentIds: mocks.listAgentIds,
}));
vi.mock("../../agents/auth-profiles/display.js", () => ({
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));
vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
}));
vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  listProfilesForProvider: mocks.listProfilesForProvider,
}));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStore,
}));
vi.mock("../../agents/auth-profiles/usage.js", () => ({
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));
vi.mock("../../agents/auth-health.js", () => ({
  DEFAULT_OAUTH_WARN_MS: 86_400_000,
  buildAuthHealthSummary: vi.fn(
    ({ store, warnAfterMs }: { store: typeof mocks.store; warnAfterMs: number }) => {
      const profiles = Object.entries(store.profiles).map(([profileId, profile]) => ({
        profileId,
        provider: profile.provider,
        type: profile.type ?? "api_key",
        status: profile.type === "api_key" ? "static" : "ok",
        source: "store",
        label: profileId,
      }));
      return {
        now: Date.now(),
        warnAfterMs,
        profiles,
        providers: profiles.map((profile) => ({
          provider: profile.provider,
          status: profile.status,
          profiles: [profile],
        })),
      };
    },
  ),
  formatRemainingShort: vi.fn(() => "1h"),
}));
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  hasUsableCustomProviderApiKey: mocks.hasUsableCustomProviderApiKey,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));
vi.mock("../../agents/model-auth-env-vars.js", () => ({
  resolveProviderEnvApiKeyCandidates: mocks.resolveProviderEnvApiKeyCandidates,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../agents/model-selection-cli.js", () => ({
  isCliProvider: vi.fn(
    (provider: string, cfg?: { agents?: { defaults?: { cliBackends?: object } } }) =>
      Object.prototype.hasOwnProperty.call(cfg?.agents?.defaults?.cliBackends ?? {}, provider),
  ),
}));
vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));
vi.mock("../../config/config.js", () => ({
  createConfigIO: mocks.createConfigIO,
}));
vi.mock("./load-config.js", () => ({
  loadModelsConfig: vi.fn(async () => mocks.loadConfig()),
}));
vi.mock("../../infra/provider-usage.js", () => ({
  formatUsageWindowSummary: vi.fn().mockReturnValue("-"),
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
  resolveUsageProviderId: vi.fn((providerId: string) => providerId),
}));
vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: mocks.resolveRuntimeSyntheticAuthProviderRefs,
}));

import { modelsStatusCommand } from "./list.status-command.js";

const defaultResolveEnvApiKeyImpl:
  | ((provider: string) => { apiKey: string; source: string } | null)
  | undefined = mocks.resolveEnvApiKey.getMockImplementation();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function withAgentScopeOverrides<T>(
  overrides: {
    primary?: string;
    fallbacks?: string[];
    agentDir?: string;
  },
  run: () => Promise<T>,
) {
  const originalPrimary = mocks.resolveAgentExplicitModelPrimary.getMockImplementation();
  const originalEffectivePrimary = mocks.resolveAgentEffectiveModelPrimary.getMockImplementation();
  const originalFallbacks = mocks.resolveAgentModelFallbacksOverride.getMockImplementation();
  const originalAgentDir = mocks.resolveAgentDir.getMockImplementation();

  mocks.resolveAgentExplicitModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentModelFallbacksOverride.mockReturnValue(overrides.fallbacks);
  if (overrides.agentDir) {
    mocks.resolveAgentDir.mockReturnValue(overrides.agentDir);
  }

  try {
    return await run();
  } finally {
    if (originalPrimary) {
      mocks.resolveAgentExplicitModelPrimary.mockImplementation(originalPrimary);
    } else {
      mocks.resolveAgentExplicitModelPrimary.mockReturnValue(undefined);
    }
    if (originalEffectivePrimary) {
      mocks.resolveAgentEffectiveModelPrimary.mockImplementation(originalEffectivePrimary);
    } else {
      mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(undefined);
    }
    if (originalFallbacks) {
      mocks.resolveAgentModelFallbacksOverride.mockImplementation(originalFallbacks);
    } else {
      mocks.resolveAgentModelFallbacksOverride.mockReturnValue(undefined);
    }
    if (originalAgentDir) {
      mocks.resolveAgentDir.mockImplementation(originalAgentDir);
    } else {
      mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw-agent");
    }
  }
}

describe("modelsStatusCommand auth overview", () => {
  it("includes masked auth sources in JSON output", async () => {
    await modelsStatusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String((runtime.log as Mock).mock.calls[0]?.[0]));

    expect(mocks.resolveOpenClawAgentDir).toHaveBeenCalled();
    expect(payload.defaultModel).toBe("anthropic/claude-opus-4-6");
    expect(payload.configPath).toBe("/tmp/openclaw-dev/openclaw.json");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-agent/auth-profiles.json");
    expect(payload.auth.shellEnvFallback.enabled).toBe(true);
    expect(payload.auth.shellEnvFallback.appliedKeys).toContain("OPENAI_API_KEY");
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.oauth.warnAfterMs).toBeGreaterThan(0);
    expect(payload.auth.oauth.profiles.length).toBeGreaterThan(0);

    const providers = payload.auth.providers as Array<{
      provider: string;
      profiles: { labels: string[] };
      env?: { value: string; source: string };
    }>;
    const anthropic = providers.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic?.profiles.labels.join(" ")).toContain("OAuth");
    expect(anthropic?.profiles.labels.join(" ")).toContain("...");

    const openai = providers.find((p) => p.provider === "openai");
    expect(openai?.env?.source).toContain("OPENAI_API_KEY");
    expect(openai?.env?.value).toContain("...");
    expect(openai?.profiles.labels.join(" ")).toContain("...");
    expect(openai?.profiles.labels.join(" ")).not.toContain("abc123");
    expect(
      (payload.auth.providersWithOAuth as string[]).some((provider) =>
        provider.startsWith("openai "),
      ),
    ).toBe(false);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "minimax",
          effective: expect.objectContaining({ kind: "env" }),
        }),
        expect.objectContaining({
          provider: "fal",
          effective: expect.objectContaining({ kind: "env" }),
        }),
      ]),
    );

    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai-codex")),
    ).toBe(true);
  });

  it("uses agent overrides and reports sources", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: "openai/gpt-4",
        fallbacks: ["openai/gpt-3.5"],
        agentDir: "/tmp/openclaw-agent-custom",
      },
      async () => {
        await modelsStatusCommand({ json: true, agent: "Jeremiah" }, localRuntime as never);
        expect(mocks.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "jeremiah");
        const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.agentId).toBe("jeremiah");
        expect(payload.agentDir).toBe("/tmp/openclaw-agent-custom");
        expect(payload.defaultModel).toBe("openai/gpt-4");
        expect(payload.fallbacks).toEqual(["openai/gpt-3.5"]);
        expect(payload.modelConfig).toEqual({
          defaultSource: "agent",
          fallbacksSource: "agent",
        });
      },
    );
  });

  it("handles cli backend and aliased provider auth summaries", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-sonnet-4-6", fallbacks: [] },
          models: { "claude-cli/claude-sonnet-4-6": {} },
          cliBackends: { "claude-cli": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      expect(payload.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
      expect(payload.auth.missingProvidersInUse).toEqual([]);

      const aliasRuntime = createRuntime();
      mocks.loadConfig.mockReturnValue({
        agents: {
          defaults: {
            model: { primary: "z.ai/glm-4.7", fallbacks: [] },
            models: { "z.ai/glm-4.7": {} },
          },
        },
        models: { providers: { "z.ai": {} } },
        env: { shellEnv: { enabled: true } },
      });
      mocks.resolveEnvApiKey.mockImplementation((provider: string) => {
        if (provider === "zai" || provider === "z.ai" || provider === "z-ai") {
          return {
            apiKey: "sk-zai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
            source: "shell env: ZAI_API_KEY",
          };
        }
        return null;
      });
      await modelsStatusCommand({ json: true }, aliasRuntime as never);
      const aliasPayload = JSON.parse(String((aliasRuntime.log as Mock).mock.calls[0]?.[0]));
      const providers = aliasPayload.auth.providers as Array<{ provider: string }>;
      expect(providers.filter((provider) => provider.provider === "zai")).toHaveLength(1);
      expect(providers.some((provider) => provider.provider === "z.ai")).toBe(false);
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });

  it("treats plugin-owned synthetic auth as usable for models in use", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalSyntheticImpl =
      mocks.resolveRuntimeSyntheticAuthProviderRefs.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5", fallbacks: [] },
          models: { "codex/gpt-5.5": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: false } },
    });
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex", "unused-synthetic"]);

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      const providers = payload.auth.providers as Array<{
        provider: string;
        syntheticAuth?: { value: string; source: string };
        effective?: { kind: string; detail?: string };
      }>;
      expect(payload.auth.missingProvidersInUse).toEqual([]);
      expect(providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            syntheticAuth: {
              value: "plugin-owned",
              source: "plugin synthetic auth",
            },
            effective: {
              kind: "synthetic",
              detail: "plugin synthetic auth",
            },
          }),
        ]),
      );
      expect(providers.some((entry) => entry.provider === "unused-synthetic")).toBe(false);
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
      if (originalSyntheticImpl) {
        mocks.resolveRuntimeSyntheticAuthProviderRefs.mockImplementation(originalSyntheticImpl);
      } else {
        mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue([]);
      }
    }
  });

  it("reports defaults source when --agent has no overrides", async () => {
    await withAgentScopeOverrides(
      {
        primary: undefined,
        fallbacks: undefined,
      },
      async () => {
        const textRuntime = createRuntime();
        await modelsStatusCommand({ agent: "main" }, textRuntime as never);
        const output = (textRuntime.log as Mock).mock.calls
          .map((call: unknown[]) => String(call[0]))
          .join("\n");
        expect(output).toContain("Default (defaults)");
        expect(output).toContain("Fallbacks (0) (defaults)");

        const jsonRuntime = createRuntime();
        await modelsStatusCommand({ json: true, agent: "main" }, jsonRuntime as never);
        const payload = JSON.parse(String((jsonRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.modelConfig).toEqual({
          defaultSource: "defaults",
          fallbacksSource: "defaults",
        });
      },
    );
  });

  it("throws when agent id is unknown", async () => {
    const localRuntime = createRuntime();
    await expect(modelsStatusCommand({ agent: "unknown" }, localRuntime as never)).rejects.toThrow(
      'Unknown agent id "unknown".',
    );
  });
  it("exits non-zero when auth is missing", async () => {
    const originalProfiles = { ...mocks.store.profiles };
    mocks.store.profiles = {};
    const localRuntime = createRuntime();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ check: true, plain: true }, localRuntime as never);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });
});
