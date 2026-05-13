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
    order: undefined as Record<string, string[]> | undefined,
  };

  return {
    store,
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
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
    loadPersistedAuthProfileStore: vi.fn().mockReturnValue(store),
    resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
    resolveAuthStorePathForDisplay: vi.fn(
      (agentDir?: string) => `${agentDir ?? "/tmp/openclaw-agent"}/auth-profiles.json`,
    ),
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
    resolveProviderEnvAuthEvidence: vi.fn().mockReturnValue({}),
    listProviderEnvAuthLookupKeys: vi
      .fn()
      .mockImplementation(() => [
        "anthropic",
        "google",
        "minimax",
        "minimax-portal",
        "openai",
        "openai-codex",
        "fal",
      ]),
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
    resolveProviderSyntheticAuthWithPlugin: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
  resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
  listAgentIds: mocks.listAgentIds,
}));
vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
}));
vi.mock("../../agents/auth-profiles/display.js", () => ({
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));
vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
}));
vi.mock("../../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: mocks.loadPersistedAuthProfileStore,
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
  listProviderEnvAuthLookupKeys: mocks.listProviderEnvAuthLookupKeys,
  resolveProviderEnvApiKeyCandidates: mocks.resolveProviderEnvApiKeyCandidates,
  resolveProviderEnvAuthEvidence: mocks.resolveProviderEnvAuthEvidence,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: vi.fn((provider: string) =>
    provider === "codex-cli" ? "openai-codex" : provider,
  ),
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
vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: mocks.resolveProviderSyntheticAuthWithPlugin,
}));

import { buildAuthHealthSummary } from "../../agents/auth-health.js";
import { modelsStatusCommand } from "./list.status-command.js";

const defaultResolveEnvApiKeyImpl:
  | ((provider: string) => { apiKey: string; source: string } | null)
  | undefined = mocks.resolveEnvApiKey.getMockImplementation();
const buildAuthHealthSummaryMock = vi.mocked(buildAuthHealthSummary);

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

function parseFirstJsonLog(runtimeLike: { log: Mock }) {
  return JSON.parse(String(runtimeLike.log.mock.calls[0]?.[0]));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not an array`);
  }
  return value;
}

function requireProvider(providers: unknown, provider: string) {
  const entry = requireArray(providers, "auth providers").find(
    (candidate) => requireRecord(candidate, "auth provider").provider === provider,
  );
  if (!entry) {
    throw new Error(`missing provider ${provider}`);
  }
  return requireRecord(entry, `provider ${provider}`);
}

function requireProfile(profiles: unknown, profileId: string) {
  const entry = requireArray(profiles, "auth profiles").find(
    (candidate) => requireRecord(candidate, "auth profile").profileId === profileId,
  );
  if (!entry) {
    throw new Error(`missing profile ${profileId}`);
  }
  return requireRecord(entry, `profile ${profileId}`);
}

function expectResolveAgentDirCalledFor(agentId: string) {
  const hasCall = mocks.resolveAgentDir.mock.calls.some((call) => call[1] === agentId);
  expect(hasCall).toBe(true);
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
    const payload = parseFirstJsonLog(runtime);

    expectResolveAgentDirCalledFor("main");
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalled();
    expect(payload.defaultModel).toBe("anthropic/claude-opus-4-6");
    expect(payload.configPath).toBe("/tmp/openclaw-dev/openclaw.json");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-agent/auth-profiles.json");
    expect(payload.auth.shellEnvFallback.enabled).toBe(true);
    expect(payload.auth.shellEnvFallback.appliedKeys).toContain("OPENAI_API_KEY");
    expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
    expect(payload.auth.oauth.warnAfterMs).toBeGreaterThan(0);
    expect(payload.auth.oauth.profiles.length).toBeGreaterThan(0);

    const providers = payload.auth.providers as Array<{
      provider: string;
      profiles: { labels: string[] };
      env?: { value: string; source: string };
    }>;
    const anthropic = providers.find((p) => p.provider === "anthropic");
    if (anthropic === undefined) {
      throw new Error("expected anthropic provider status");
    }
    expect(anthropic.profiles.labels.join(" ")).toContain("OAuth");
    expect(anthropic.profiles.labels.join(" ")).toContain("...");

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
    expect(
      requireRecord(requireProvider(providers, "minimax").effective, "minimax effective").kind,
    ).toBe("env");
    expect(requireRecord(requireProvider(providers, "fal").effective, "fal effective").kind).toBe(
      "env",
    );

    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai-codex")),
    ).toBe(true);
  });

  it("honors OPENCLAW_AGENT_DIR when no --agent override is provided", async () => {
    const localRuntime = createRuntime();
    const previous = process.env.OPENCLAW_AGENT_DIR;
    process.env.OPENCLAW_AGENT_DIR = "/tmp/openclaw-isolated-agent";
    mocks.resolveAgentDir.mockClear();
    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previous;
      }
    }

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-isolated-agent");
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.agentDir).toBe("/tmp/openclaw-isolated-agent");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-isolated-agent/auth-profiles.json");
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
        expectResolveAgentDirCalledFor("jeremiah");
        const payload = parseFirstJsonLog(localRuntime);
        expect(payload.agentId).toBe("jeremiah");
        expect(payload.agentDir).toBe("/tmp/openclaw-agent-custom");
        expect(payload.defaultModel).toBe("openai/gpt-4");
        expect(payload.fallbacks).toEqual(["openai/gpt-3.5"]);
        expect(payload.modelConfig).toEqual({
          defaultSource: "agent",
          fallbacksSource: "agent",
        });
        const openAiCodex = (
          payload.auth.providers as Array<{
            provider: string;
            effective?: { kind: string; detail?: string };
          }>
        ).find((provider) => provider.provider === "openai-codex");
        expect(openAiCodex?.effective).toEqual({
          kind: "profiles",
          detail: "/tmp/openclaw-agent-custom/auth-profiles.json",
        });
      },
    );
  });

  it("does not report canonical OpenAI agent routes missing when Codex auth is present", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: [] },
          models: { "openai/gpt-5.5": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "openai-codex:default": originalProfiles["openai-codex:default"],
    };
    mocks.resolveEnvApiKey.mockImplementation((provider: string) =>
      provider === "openai-codex"
        ? {
            apiKey: "oauth-token",
            source: "env: OPENAI_OAUTH_TOKEN",
          }
        : null,
    );

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
      expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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

  it("does not fail --check for stale Codex inventory when ordered provider health is usable", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalOrder = mocks.store.order ? { ...mocks.store.order } : undefined;
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalHealthImpl = buildAuthHealthSummaryMock.getMockImplementation();
    const expiredProfile = {
      type: "oauth",
      provider: "openai-codex",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: Date.now() - 60_000,
    };
    const usableProfile = {
      type: "oauth",
      provider: "openai-codex",
      access: "usable-access",
      refresh: "usable-refresh",
      expires: Date.now() + 60_000,
    };
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: [] },
          models: { "openai/gpt-5.5": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "openai-codex:default": expiredProfile,
      "openai-codex:named": usableProfile,
    };
    mocks.store.order = {
      "openai-codex": ["openai-codex:named"],
    };
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    buildAuthHealthSummaryMock.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86_400_000,
      profiles: [
        {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          type: "oauth",
          status: "expired",
          source: "store",
          label: "openai-codex:default",
        },
        {
          profileId: "openai-codex:named",
          provider: "openai-codex",
          type: "oauth",
          status: "ok",
          expiresAt: Date.now() + 60_000,
          remainingMs: 60_000,
          source: "store",
          label: "openai-codex:named",
        },
      ],
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          expiresAt: Date.now() + 60_000,
          remainingMs: 60_000,
          profiles: [],
        },
      ],
    });

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual([]);
      expect(requireProfile(payload.auth.oauth.profiles, "openai-codex:default").status).toBe(
        "expired",
      );
      expect(requireProfile(payload.auth.oauth.profiles, "openai-codex:named").status).toBe("ok");
      expect(requireProvider(payload.auth.oauth.providers, "openai-codex").status).toBe("ok");
      expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
      mocks.store.order = originalOrder;
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
      if (originalHealthImpl) {
        buildAuthHealthSummaryMock.mockImplementation(originalHealthImpl);
      }
    }
  });

  it("fails --check when an in-use provider alias has expired canonical auth health", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalHealthImpl = buildAuthHealthSummaryMock.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "codex-cli/gpt-5.5", fallbacks: [] },
          models: { "codex-cli/gpt-5.5": {} },
          cliBackends: { "codex-cli": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      },
    };
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    buildAuthHealthSummaryMock.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86_400_000,
      profiles: [
        {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          type: "oauth",
          status: "expired",
          source: "store",
          label: "openai-codex:default",
        },
      ],
      providers: [
        {
          provider: "openai-codex",
          status: "expired",
          expiresAt: Date.now() - 60_000,
          remainingMs: -60_000,
          profiles: [],
        },
      ],
    });

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual([]);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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
      if (originalHealthImpl) {
        buildAuthHealthSummaryMock.mockImplementation(originalHealthImpl);
      }
    }
  });

  it("uses resolved configured model aliases when filtering provider health", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalHealthImpl = buildAuthHealthSummaryMock.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "Opus", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      },
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "abc123",
      },
    };
    mocks.resolveEnvApiKey.mockImplementation((provider: string) =>
      provider === "openai"
        ? {
            apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz",
            source: "shell env: OPENAI_API_KEY",
          }
        : null,
    );
    buildAuthHealthSummaryMock.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86_400_000,
      profiles: [
        {
          profileId: "anthropic:default",
          provider: "anthropic",
          type: "oauth",
          status: "expired",
          source: "store",
          label: "anthropic:default",
        },
      ],
      providers: [
        {
          provider: "anthropic",
          status: "expired",
          expiresAt: Date.now() - 60_000,
          remainingMs: -60_000,
          profiles: [],
        },
      ],
    });

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.resolvedDefault).toBe("anthropic/claude-opus-4-6");
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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
      if (originalHealthImpl) {
        buildAuthHealthSummaryMock.mockImplementation(originalHealthImpl);
      }
    }
  });

  it("does not fail --check when profile health is missing but non-profile auth is usable", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalOrder = mocks.store.order ? { ...mocks.store.order } : undefined;
    const originalHealthImpl = buildAuthHealthSummaryMock.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
      auth: {
        order: {
          anthropic: [],
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {};
    mocks.store.order = {
      anthropic: [],
    };
    buildAuthHealthSummaryMock.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86_400_000,
      profiles: [
        {
          profileId: "anthropic:default",
          provider: "anthropic",
          type: "oauth",
          status: "ok",
          source: "store",
          label: "anthropic:default",
        },
      ],
      providers: [
        {
          provider: "anthropic",
          status: "missing",
          profiles: [],
        },
      ],
    });

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(
        requireRecord(requireProvider(payload.auth.providers, "anthropic").env, "anthropic env")
          .source,
      ).toBe("env: ANTHROPIC_OAUTH_TOKEN");
      expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(localRuntime.exit).not.toHaveBeenCalledWith(2);
    } finally {
      mocks.store.profiles = originalProfiles;
      mocks.store.order = originalOrder;
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalHealthImpl) {
        buildAuthHealthSummaryMock.mockImplementation(originalHealthImpl);
      }
    }
  });

  it("reports missing auth when explicit auth order disables stored profiles", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalOrder = mocks.store.order ? { ...mocks.store.order } : undefined;
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
      auth: {
        order: {
          anthropic: [],
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "usable-access",
        refresh: "usable-refresh",
        expires: Date.now() + 60_000,
      },
    };
    mocks.store.order = undefined;
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual(["anthropic"]);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
      mocks.store.order = originalOrder;
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

  it("does fail --check when the only models.json auth is not resolvable", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalCustomKeyImpl = mocks.getCustomProviderApiKey.getMockImplementation();
    const originalUsableCustomKeyImpl =
      mocks.resolveUsableCustomProviderApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
      models: {
        providers: {
          anthropic: {
            apiKey: "ANTHROPIC_API_KEY",
          },
        },
      },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {};
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.getCustomProviderApiKey.mockImplementation((provider: string) =>
      provider === "anthropic" ? "ANTHROPIC_API_KEY" : undefined,
    );
    mocks.resolveUsableCustomProviderApiKey.mockImplementation(() => null);
    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual(["anthropic"]);
      expect(
        mocks.resolveUsableCustomProviderApiKey.mock.calls.some(
          ([params]) =>
            requireRecord(params, "custom provider key params").provider === "anthropic",
        ),
      ).toBe(true);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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
      if (originalCustomKeyImpl) {
        mocks.getCustomProviderApiKey.mockImplementation(originalCustomKeyImpl);
      } else {
        mocks.getCustomProviderApiKey.mockReturnValue(undefined);
      }
      if (originalUsableCustomKeyImpl) {
        mocks.resolveUsableCustomProviderApiKey.mockImplementation(originalUsableCustomKeyImpl);
      } else {
        mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
      }
    }
  });

  it("keeps Codex auth fallback scoped away from OpenAI image routes", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4.6", fallbacks: [] },
          imageModel: { primary: "openai/gpt-image-2", fallbacks: [] },
          models: { "anthropic/claude-sonnet-4.6": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.store.profiles = {
      "anthropic:default": originalProfiles["anthropic:default"],
      "openai-codex:default": originalProfiles["openai-codex:default"],
    };
    mocks.resolveEnvApiKey.mockImplementation((provider: string) =>
      provider === "openai-codex"
        ? {
            apiKey: "oauth-token",
            source: "env: OPENAI_OAUTH_TOKEN",
          }
        : null,
    );

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual(["openai"]);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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

  it("does not double-prefix provider-qualified resolved default models", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openrouter/auto", fallbacks: [] },
          models: { "openrouter/auto": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);

      expect(payload.defaultModel).toBe("openrouter/auto");
      expect(payload.resolvedDefault).toBe("openrouter/auto");
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
    }
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
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
      expect(payload.auth.missingProvidersInUse).toStrictEqual([]);

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
      const aliasPayload = parseFirstJsonLog(aliasRuntime);
      const providers = aliasPayload.auth.providers as Array<{ provider: string }>;
      expect(
        providers.reduce((count, provider) => count + (provider.provider === "zai" ? 1 : 0), 0),
      ).toBe(1);
      expect(providers.map((provider) => provider.provider)).not.toContain("z.ai");
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
    const originalResolveSyntheticAuthImpl =
      mocks.resolveProviderSyntheticAuthWithPlugin.getMockImplementation();
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
    mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "codex"
          ? {
              apiKey: "codex-runtime-token",
              source: "codex-app-server",
              mode: "token",
              expiresAt: Date.now() + 60_000,
            }
          : undefined,
    );

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      const providers = payload.auth.providers as Array<{
        provider: string;
        syntheticAuth?: { value: string; source: string };
        effective?: { kind: string; detail?: string };
      }>;
      expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
      const codexProvider = requireProvider(providers, "codex");
      expectRecordFields(requireRecord(codexProvider.syntheticAuth, "codex synthetic auth"), {
        value: "plugin-owned",
        source: "codex-app-server",
      });
      expectRecordFields(requireRecord(codexProvider.effective, "codex effective auth"), {
        kind: "synthetic",
        detail: "codex-app-server",
      });
      expect(providers.map((entry) => entry.provider)).not.toContain("unused-synthetic");
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
      if (originalResolveSyntheticAuthImpl) {
        mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
          originalResolveSyntheticAuthImpl,
        );
      } else {
        mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);
      }
    }
  });

  it("does not treat declared but unresolved synthetic auth as usable", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    const originalSyntheticImpl =
      mocks.resolveRuntimeSyntheticAuthProviderRefs.getMockImplementation();
    const originalResolveSyntheticAuthImpl =
      mocks.resolveProviderSyntheticAuthWithPlugin.getMockImplementation();
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
    mocks.store.profiles = {};
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual(["codex"]);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
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
      if (originalResolveSyntheticAuthImpl) {
        mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
          originalResolveSyntheticAuthImpl,
        );
      } else {
        mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);
      }
    }
  });

  it("includes auth-evidence-only providers in the auth overview", async () => {
    const localRuntime = createRuntime();
    const originalKeysImpl = mocks.listProviderEnvAuthLookupKeys.getMockImplementation();
    const originalEvidenceImpl = mocks.resolveProviderEnvAuthEvidence.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();

    mocks.listProviderEnvAuthLookupKeys.mockReturnValue(["workspace-cloud"]);
    mocks.resolveProviderEnvAuthEvidence.mockReturnValue({
      "workspace-cloud": [
        {
          type: "local-file-with-env",
          credentialMarker: "workspace-cloud-local-credentials",
          source: "workspace cloud credentials",
        },
      ],
    });
    mocks.resolveEnvApiKey.mockImplementation(
      (provider: string, _env?: NodeJS.ProcessEnv, options?: { workspaceDir?: string }) =>
        provider === "workspace-cloud" && options?.workspaceDir === "/tmp/openclaw-agent/workspace"
          ? {
              apiKey: "workspace-cloud-local-credentials",
              source: "workspace cloud credentials",
            }
          : null,
    );

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      const workspaceProvider = requireProvider(payload.auth.providers, "workspace-cloud");
      expect(requireRecord(workspaceProvider.effective, "workspace effective auth").kind).toBe(
        "env",
      );
      expect(requireRecord(workspaceProvider.env, "workspace env auth").source).toBe(
        "workspace cloud credentials",
      );
    } finally {
      if (originalKeysImpl) {
        mocks.listProviderEnvAuthLookupKeys.mockImplementation(originalKeysImpl);
      }
      if (originalEvidenceImpl) {
        mocks.resolveProviderEnvAuthEvidence.mockImplementation(originalEvidenceImpl);
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
        const payload = parseFirstJsonLog(jsonRuntime);
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
