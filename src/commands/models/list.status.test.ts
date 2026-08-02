// Model list status tests cover status column construction and auth/probe summaries.
import { describe, expect, it, type Mock, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => {
  type MockAuthProfile = { provider: string; [key: string]: unknown };
  type MockAuthStore = {
    version: number;
    profiles: Record<string, MockAuthProfile>;
    order?: Record<string, string[]>;
  };
  const store: MockAuthStore = {
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
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access: "eyJhbGciOi-ACCESS",
        refresh: "oai-refresh-1234567890",
        expires: Date.now() + 60_000,
      },
      "openai:api-key": {
        type: "api_key",
        provider: "openai",
        key: "abc123", // pragma: allowlist secret
      },
    } as Record<string, MockAuthProfile>,
    order: undefined as Record<string, string[]> | undefined,
  };
  const runtimeStore = { current: undefined as MockAuthStore | undefined };

  return {
    store,
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
    resolveSessionAgentIds: vi.fn(({ agentId }: { agentId?: string } = {}) => ({
      defaultAgentId: "main",
      sessionAgentId: agentId ?? "main",
    })),
    resolveAgentExplicitModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
    resolveAgentConfig: vi.fn().mockReturnValue(undefined),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    listAgentEntries: vi.fn().mockReturnValue([{ id: "main" }, { id: "jeremiah" }]),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    getRuntimeAuthProfileStoreSnapshot: vi.fn(() => runtimeStore.current),
    runtimeStore,
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
    resolveProviderEnvAuthLookupMaps: vi.fn().mockReturnValue({
      aliasMap: { "codex-cli": "openai" },
      envCandidateMap: {
        anthropic: ["ANTHROPIC_API_KEY"],
        google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        minimax: ["MINIMAX_API_KEY"],
        "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
        openai: ["OPENAI_OAUTH_TOKEN", "OPENAI_API_KEY"],
        fal: ["FAL_KEY"],
      },
      authEvidenceMap: {},
    }),
    listProviderEnvAuthLookupKeys: vi
      .fn()
      .mockImplementation(() => [
        "anthropic",
        "google",
        "minimax",
        "minimax-portal",
        "openai",
        "openai",
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
    resolveAgentHarnessOwnerPluginIds: vi.fn().mockReturnValue(["codex"]),
    runPluginPayloadSmokeCheckForManifestRecords: vi
      .fn()
      .mockResolvedValue({ checked: ["codex"], failures: [] }),
    resolveAgentHarnessRuntimeAvailability: vi.fn().mockReturnValue({
      status: "available",
      ownerPluginIds: ["codex"],
    }),
    loadModelCatalog: vi.fn().mockResolvedValue([]),
    modelCatalogRouteVariants: undefined as unknown[] | undefined,
    openAIModelRouteOverride: undefined as ((params: unknown) => unknown) | undefined,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveSessionAgentIds: mocks.resolveSessionAgentIds,
  resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
  resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
  resolveAgentConfig: mocks.resolveAgentConfig,
  listAgentIds: mocks.listAgentIds,
  listAgentEntries: mocks.listAgentEntries,
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
vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStore,
  getRuntimeAuthProfileStoreSnapshot: mocks.getRuntimeAuthProfileStoreSnapshot,
}));
vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  getRuntimeAuthProfileStoreSnapshot: mocks.getRuntimeAuthProfileStoreSnapshot,
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
vi.mock("../../agents/model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-auth.js")>()),
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  hasUsableCustomProviderApiKey: mocks.hasUsableCustomProviderApiKey,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));
vi.mock("../../agents/model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-auth-env.js")>()),
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));
vi.mock("../../agents/model-auth-env-vars.js", () => ({
  listProviderEnvAuthLookupKeys: mocks.listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps: mocks.resolveProviderEnvAuthLookupMaps,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: vi.fn(() => ({ "codex-cli": "openai" })),
  resolveProviderIdForAuth: vi.fn((provider: string) =>
    provider === "codex-cli" ? "openai" : provider,
  ),
}));
vi.mock("../../agents/model-selection-cli.js", () => ({
  isCliProvider: vi.fn((provider: string) => provider === "claude-cli"),
}));
vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
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
vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  resolveAgentHarnessOwnerPluginIds: mocks.resolveAgentHarnessOwnerPluginIds,
  resolveAgentHarnessRuntimeAvailability: mocks.resolveAgentHarnessRuntimeAvailability,
}));
vi.mock("../../cli/update-cli/plugin-payload-validation.js", () => ({
  runPluginPayloadSmokeCheckForManifestRecords: mocks.runPluginPayloadSmokeCheckForManifestRecords,
}));
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await mocks.loadModelCatalog(...args);
    return { entries, routeVariants: mocks.modelCatalogRouteVariants ?? entries };
  },
}));
vi.mock("../../agents/openai-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/openai-model-routes.js")>();
  return {
    ...actual,
    resolveOpenAIModelRoutes: (params: Parameters<typeof actual.resolveOpenAIModelRoutes>[0]) =>
      mocks.openAIModelRouteOverride
        ? mocks.openAIModelRouteOverride(params)
        : actual.resolveOpenAIModelRoutes(params),
    createOpenAIModelRoutesResolver: (
      params: Parameters<typeof actual.createOpenAIModelRoutesResolver>[0],
    ) => {
      const resolveRoutes = actual.createOpenAIModelRoutesResolver(params);
      return (ref: Parameters<ReturnType<typeof actual.createOpenAIModelRoutesResolver>>[0]) =>
        mocks.openAIModelRouteOverride
          ? mocks.openAIModelRouteOverride({ provider: "openai", ...ref })
          : resolveRoutes(ref);
    },
  };
});

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

async function withOpenAIStatusFixture<T>(
  params: {
    primary: string;
    fallbacks?: string[];
    profiles: typeof mocks.store.profiles;
    resolveEnvApiKey?: (provider: string) => { apiKey: string; source: string } | null;
    routeOverride?: (params: unknown) => unknown;
    authOrder?: string[];
    providerAuth?: "api-key" | "aws-sdk" | "oauth" | "token";
    providerApiKey?: unknown;
    providerApi?: "openai-chatgpt-responses";
    providerBaseUrl?: string;
    agentRuntime?: string;
    catalog?: unknown[];
    routeVariants?: unknown[];
    utilityModel?: string;
    modelPolicyAllow?: string[];
  },
  run: () => Promise<T>,
): Promise<T> {
  const originalLoadConfig = mocks.loadConfig.getMockImplementation();
  const originalProfiles = { ...mocks.store.profiles };
  const originalOrder = mocks.store.order ? { ...mocks.store.order } : undefined;
  const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
  const originalCustomKeyImpl = mocks.getCustomProviderApiKey.getMockImplementation();
  const originalUsableCustomKeyImpl =
    mocks.resolveUsableCustomProviderApiKey.getMockImplementation();
  const originalRouteOverride = mocks.openAIModelRouteOverride;
  const originalCatalogImpl = mocks.loadModelCatalog.getMockImplementation();
  const originalRouteVariants = mocks.modelCatalogRouteVariants;
  const configuredModels = Object.fromEntries(
    [params.primary, ...(params.fallbacks ?? [])].map((model) => [model, {}]),
  );
  mocks.loadConfig.mockReturnValue({
    agents: {
      defaults: {
        model: { primary: params.primary, fallbacks: params.fallbacks ?? [] },
        ...(params.modelPolicyAllow
          ? { modelPolicy: { allow: params.modelPolicyAllow } }
          : undefined),
        // Route tests target the configured primary/fallback models; keep the
        // derived utility model out unless a test opts in explicitly.
        utilityModel: params.utilityModel ?? "",
        models: Object.fromEntries(
          Object.keys(configuredModels).map((model) => [
            model,
            params.agentRuntime ? { agentRuntime: { id: params.agentRuntime } } : {},
          ]),
        ),
      },
    },
    ...(params.authOrder ? { auth: { order: { openai: params.authOrder } } } : {}),
    models: {
      providers:
        params.providerAuth ||
        params.providerApiKey !== undefined ||
        params.providerApi ||
        params.providerBaseUrl
          ? {
              openai: {
                ...(params.providerAuth ? { auth: params.providerAuth } : {}),
                ...(params.providerApiKey !== undefined ? { apiKey: params.providerApiKey } : {}),
                ...(params.providerApi ? { api: params.providerApi } : {}),
                ...(params.providerBaseUrl ? { baseUrl: params.providerBaseUrl } : {}),
                models: [],
              },
            }
          : {},
    },
    env: { shellEnv: { enabled: false } },
  });
  mocks.store.profiles = params.profiles;
  mocks.store.order = undefined;
  mocks.resolveEnvApiKey.mockImplementation(params.resolveEnvApiKey ?? (() => null));
  const providerApiKey =
    typeof params.providerApiKey === "string" ? params.providerApiKey.trim() : "";
  if (providerApiKey) {
    mocks.getCustomProviderApiKey.mockImplementation((_cfg, provider) =>
      provider === "openai" ? providerApiKey : undefined,
    );
    mocks.resolveUsableCustomProviderApiKey.mockImplementation(({ provider }) =>
      provider === "openai" ? { apiKey: providerApiKey, source: "models.json" } : null,
    );
  }
  mocks.openAIModelRouteOverride = params.routeOverride;
  mocks.loadModelCatalog.mockResolvedValue(params.catalog ?? []);
  mocks.modelCatalogRouteVariants = params.routeVariants;
  try {
    return await run();
  } finally {
    mocks.store.profiles = originalProfiles;
    mocks.store.order = originalOrder;
    mocks.openAIModelRouteOverride = originalRouteOverride;
    mocks.modelCatalogRouteVariants = originalRouteVariants;
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
    if (originalCatalogImpl) {
      mocks.loadModelCatalog.mockImplementation(originalCatalogImpl);
    } else {
      mocks.loadModelCatalog.mockResolvedValue([]);
    }
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
}

describe("modelsStatusCommand auth overview", () => {
  it.each([
    [{ probeTimeout: "5000ms" }, "--probe-timeout"],
    [{ probeConcurrency: "2.5" }, "--probe-concurrency"],
    [{ probeMaxTokens: "64x" }, "--probe-max-tokens"],
  ])("rejects partial probe numeric option %s", async (opts, label) => {
    await expect(
      modelsStatusCommand({ json: true, ...opts }, createRuntime() as never),
    ).rejects.toThrow(label);
  });

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
    expect(payload.auth.providersWithOAuth).toContain("openai (1)");
    expect(
      requireRecord(requireProvider(providers, "minimax").effective, "minimax effective").kind,
    ).toBe("env");
    expect(requireRecord(requireProvider(providers, "fal").effective, "fal effective").kind).toBe(
      "env",
    );

    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect((payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai"))).toBe(
      true,
    );
  });

  it("expands nested wildcard policy entries to the models they actually allow", async () => {
    await withOpenAIStatusFixture(
      {
        primary: "clawrouter/anthropic/claude-haiku-4-5",
        profiles: {},
        modelPolicyAllow: ["clawrouter/anthropic/*"],
        catalog: [
          {
            provider: "clawrouter",
            id: "anthropic/claude-haiku-4-5",
            name: "Claude Haiku",
          },
          {
            provider: "clawrouter",
            id: "google/gemini-3.5-flash",
            name: "Gemini Flash",
          },
          { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        ],
      },
      async () => {
        const localRuntime = createRuntime();
        await modelsStatusCommand({ json: true }, localRuntime as never);

        expect(parseFirstJsonLog(localRuntime).allowed).toEqual([
          "clawrouter/anthropic/claude-haiku-4-5",
        ]);
      },
    );
  });

  it("preserves a restrictive wildcard when the current catalog has no match", async () => {
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.6-sol",
        profiles: {},
        modelPolicyAllow: ["clawrouter/anthropic/*"],
        catalog: [{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      },
      async () => {
        const localRuntime = createRuntime();
        await modelsStatusCommand({ json: true }, localRuntime as never);

        expect(parseFirstJsonLog(localRuntime).allowed).toEqual(["clawrouter/anthropic/*"]);
      },
    );
  });

  it("reports the resolved utility model in JSON output", async () => {
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const baseConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    };
    try {
      mocks.loadConfig.mockReturnValue({
        ...baseConfig,
        agents: {
          defaults: { ...baseConfig.agents.defaults, utilityModel: "openai/gpt-5.6-luna" },
        },
      });
      const explicitRuntime = createRuntime();
      await modelsStatusCommand({ json: true }, explicitRuntime as never);
      expect(parseFirstJsonLog(explicitRuntime).utilityModel).toEqual({
        ref: "openai/gpt-5.6-luna",
        source: "config",
      });

      mocks.loadConfig.mockReturnValue({
        ...baseConfig,
        agents: {
          defaults: { ...baseConfig.agents.defaults, utilityModel: "" },
        },
      });
      const disabledRuntime = createRuntime();
      await modelsStatusCommand({ json: true }, disabledRuntime as never);
      expect(parseFirstJsonLog(disabledRuntime).utilityModel).toEqual({
        ref: null,
        source: "disabled",
      });

      // The utility model is a real runtime auth consumer: a provider that only
      // narration/titles use must enter the route/auth analysis instead of
      // staying invisible to `models status`.
      mocks.loadConfig.mockReturnValue({
        ...baseConfig,
        agents: {
          defaults: { ...baseConfig.agents.defaults, utilityModel: "mistral/mistral-small" },
        },
      });
      const missingAuthRuntime = createRuntime();
      await modelsStatusCommand({ json: true }, missingAuthRuntime as never);
      const missingPayload = parseFirstJsonLog(missingAuthRuntime);
      expect(missingPayload.utilityModel).toEqual({
        ref: "mistral/mistral-small",
        source: "config",
      });
      expect(missingPayload.auth.modelRouteIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "mistral", model: "mistral-small" }),
        ]),
      );

      // Aliases are valid utilityModel input; the report shows the canonical ref.
      mocks.loadConfig.mockReturnValue({
        ...baseConfig,
        agents: {
          defaults: {
            ...baseConfig.agents.defaults,
            models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
            utilityModel: "Opus",
          },
        },
      });
      const aliasRuntime = createRuntime();
      await modelsStatusCommand({ json: true }, aliasRuntime as never);
      expect(parseFirstJsonLog(aliasRuntime).utilityModel).toEqual({
        ref: "anthropic/claude-opus-4-6",
        source: "config",
      });
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
    }
  });

  it("honors OPENCLAW_AGENT_DIR when no --agent override is provided", async () => {
    const localRuntime = createRuntime();
    mocks.resolveAgentDir.mockClear();
    await withEnvAsync({ OPENCLAW_AGENT_DIR: "/tmp/openclaw-isolated-agent" }, async () => {
      await modelsStatusCommand({ json: true }, localRuntime as never);
    });

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-isolated-agent");
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.agentDir).toBe("/tmp/openclaw-isolated-agent");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-isolated-agent/auth-profiles.json");
  });

  it("honors deprecated PI_CODING_AGENT_DIR when OPENCLAW_AGENT_DIR is unset", async () => {
    const localRuntime = createRuntime();
    mocks.resolveAgentDir.mockClear();
    await withEnvAsync(
      {
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: "/tmp/openclaw-legacy-agent",
      },
      async () => {
        await modelsStatusCommand({ json: true }, localRuntime as never);
      },
    );

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-legacy-agent");
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.agentDir).toBe("/tmp/openclaw-legacy-agent");
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
        ).find((provider) => provider.provider === "openai");
        expect(openAiCodex?.effective).toEqual({
          kind: "profiles",
          detail: "/tmp/openclaw-agent-custom/auth-profiles.json",
        });
      },
    );
  });

  it("rejects API-key auth for subscription-only Codex Spark", async () => {
    const localRuntime = createRuntime();
    const textRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.3-codex-spark",
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-openai-platform-only", // pragma: allowlist secret
          },
        },
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
        await modelsStatusCommand({ check: true }, textRuntime as never);
      },
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual(["openai"]);
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        provider: "openai",
        runtime: "codex",
        authProvider: "openai",
        status: "missing",
        effective: { kind: "missing", detail: "missing" },
      },
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.log.mock.calls.flat().join("\n")).not.toContain("set an API key env var");
  });

  it("reports usable Codex auth as unavailable when its harness plugin is quarantined", async () => {
    const localRuntime = createRuntime();
    const textRuntime = createRuntime();
    const payloadFailure = {
      pluginId: "codex",
      installPath: "/private/plugin",
      reason: "missing-package-dir" as const,
      detail: "missing",
    };
    mocks.runPluginPayloadSmokeCheckForManifestRecords
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] })
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] });
    const resolveAvailability = (params: {
      payloadFailures: Array<{ pluginId: string; reason: string }>;
    }) =>
      params.payloadFailures.some((failure) => failure.pluginId === "codex")
        ? {
            status: "unavailable",
            ownerPluginIds: ["codex", "openai"],
            reason: "owner-plugin-degraded",
            detail:
              'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
          }
        : { status: "available", ownerPluginIds: ["codex", "openai"] };
    mocks.resolveAgentHarnessRuntimeAvailability
      .mockImplementationOnce(resolveAvailability)
      .mockImplementationOnce(resolveAvailability);
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.5",
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
        await modelsStatusCommand({ check: true }, textRuntime as never);
      },
    );

    expect(mocks.runPluginPayloadSmokeCheckForManifestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env }),
    );
    expect(mocks.resolveAgentHarnessRuntimeAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "codex",
        provider: "openai",
        payloadFailures: [payloadFailure],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: expect.any(Map),
      }),
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        provider: "openai",
        runtime: "codex",
        authProvider: "openai",
        status: "unavailable",
        authStatus: "usable",
        runtimeStatus: "unavailable",
        runtimeReason: "owner-plugin-degraded",
        runtimeDetail:
          'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
        runtimePluginIds: ["codex", "openai"],
        effective: {
          kind: "profiles",
          detail: "/tmp/openclaw-agent/auth-profiles.json",
        },
      },
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.log.mock.calls.flat().join("\n")).toContain("status=unavailable");
    expect(textRuntime.log.mock.calls.flat().join("\n")).toContain("auth=usable");
    expect(textRuntime.log.mock.calls.flat().join("\n")).toContain("runtime=unavailable");
  });

  it("evaluates mixed primary and fallback OpenAI routes independently", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.6",
        fallbacks: ["openai/gpt-5.5"],
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      },
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual(["openai"]);
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        provider: "openai",
        runtime: "codex",
        authProvider: "openai",
        status: "missing",
        effective: {
          kind: "profiles",
          detail: "/tmp/openclaw-agent/auth-profiles.json",
        },
      },
    ]);
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "missing-auth",
        provider: "openai",
        model: "gpt-5.6",
        authRequirement: "api-key",
        message: "No usable api-key authentication is available for openai/gpt-5.6.",
      },
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("flags a utility model whose route needs api-key auth despite an OAuth-healthy primary", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.5",
        utilityModel: "openai/gpt-5.6",
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      },
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.utilityModel).toEqual({ ref: "openai/gpt-5.6", source: "config" });
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "missing-auth",
        provider: "openai",
        model: "gpt-5.6",
        authRequirement: "api-key",
        message: "No usable api-key authentication is available for openai/gpt-5.6.",
      },
    ]);
  });

  it("reports incompatible model routes separately in JSON and text", async () => {
    const jsonRuntime = createRuntime();
    const textRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.6",
        profiles: {},
        routeOverride: () => ({
          kind: "incompatible",
          code: "platform-only-model-on-chatgpt",
          message: "gpt-5.6 is available only through OpenAI Platform API-key authentication.",
        }),
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, jsonRuntime as never);
        await modelsStatusCommand({ check: true }, textRuntime as never);
      },
    );
    const payload = parseFirstJsonLog(jsonRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "incompatible",
        provider: "openai",
        model: "gpt-5.6",
        code: "platform-only-model-on-chatgpt",
        message: "gpt-5.6 is available only through OpenAI Platform API-key authentication.",
      },
    ]);
    const text = textRuntime.log.mock.calls.flat().join("\n");
    expect(text).toContain("openai/gpt-5.6");
    expect(text).toContain("platform-only-model-on-chatgpt");
    expect(text).toContain("available only through OpenAI Platform API-key authentication");
    expect(jsonRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("reports missing static transport observation as indeterminate", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.4-nano",
        profiles: {
          "openai:subscription": {
            type: "oauth",
            provider: "openai",
            access: "subscription-access",
            refresh: "subscription-refresh",
            expires: Date.now() + 10 * 60_000,
          },
        },
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      },
    );

    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({
        kind: "indeterminate",
        provider: "openai",
        model: "gpt-5.4-nano",
      }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("uses static catalog transport observation for route readiness", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.4-nano",
        profiles: {
          "openai:subscription": {
            type: "oauth",
            provider: "openai",
            access: "subscription-access",
            refresh: "subscription-refresh",
            expires: Date.now() + 10 * 60_000,
          },
        },
        catalog: [
          {
            id: "gpt-5.4-nano",
            name: "GPT 5.4 Nano",
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      },
    );

    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it.each([
    ["ChatGPT first", false],
    ["Platform first", true],
  ])("selects ChatGPT nano from grouped physical routes with %s", async (_label, reverse) => {
    const localRuntime = createRuntime();
    const platform = {
      id: "gpt-5.4-nano",
      name: "Platform Nano",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const chatGPT = {
      id: "openai/gpt-5.4-nano",
      name: "ChatGPT Nano",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const routeVariants = reverse ? [platform, chatGPT] : [chatGPT, platform];
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.4-nano",
        profiles: {
          "openai:subscription": {
            type: "oauth",
            provider: "openai",
            access: "subscription-access",
            refresh: "subscription-refresh",
            expires: Date.now() + 10 * 60_000,
          },
        },
        authOrder: ["openai:subscription"],
        catalog: [platform],
        routeVariants,
      },
      async () => {
        await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      },
    );

    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("keeps API-key SecretRef profiles usable for a concrete OpenAI route", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.6",
        profiles: {
          "openai:ref": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
      async () =>
        await withEnvAsync({ OPENAI_API_KEY: "resolved-key" }, async () => {
          await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
        }),
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("reports unresolved API-key SecretRef profiles as indeterminate", async () => {
    const localRuntime = createRuntime();
    await withOpenAIStatusFixture(
      {
        primary: "openai/gpt-5.6",
        profiles: {
          "openai:ref": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
      async () =>
        await withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
          await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
        }),
    );
    const payload = parseFirstJsonLog(localRuntime);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({
        kind: "indeterminate",
        provider: "openai",
        model: "gpt-5.6",
        evidence: "profile",
      }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves configured AWS SDK profiles for non-OpenAI providers", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalProfiles = { ...mocks.store.profiles };
    const originalOrder = mocks.store.order ? { ...mocks.store.order } : undefined;
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "bedrock/anthropic.claude-sonnet", fallbacks: [] },
          models: { "bedrock/anthropic.claude-sonnet": {} },
        },
      },
      auth: {
        profiles: {
          "bedrock:default": { provider: "bedrock", mode: "aws-sdk" },
        },
        order: { bedrock: ["bedrock:default"] },
      },
      models: {
        providers: {
          bedrock: { auth: "aws-sdk", models: [] },
        },
      },
      env: { shellEnv: { enabled: false } },
    });
    mocks.store.profiles = {};
    mocks.store.order = undefined;
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ json: true, check: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      expect(payload.auth.missingProvidersInUse).toEqual([]);
      expect(payload.auth.modelRouteIssues).toEqual([]);
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
    }
  });

  it("handles cli backend and exact provider auth summaries", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-sonnet-4-6", fallbacks: [] },
          models: { "claude-cli/claude-sonnet-4-6": {} },
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
        providers.reduce((count, provider) => count + (provider.provider === "z.ai" ? 1 : 0), 0),
      ).toBe(1);
      expect(providers.map((provider) => provider.provider)).not.toContain("zai");
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
      const syntheticProbeStart = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls.length;
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = parseFirstJsonLog(localRuntime);
      const providers = payload.auth.providers as Array<{
        provider: string;
        syntheticAuth?: { value: string; source: string };
        effective?: { kind: string; detail?: string };
      }>;
      const syntheticProbeProviders = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls
        .slice(syntheticProbeStart)
        .map(([arg]) => (arg as { provider: string }).provider);
      expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
      const codexProvider = requireProvider(providers, "codex");
      expectRecordFields(requireRecord(codexProvider.syntheticAuth, "codex synthetic auth"), {
        value: "plugin-owned",
        source: "codex-app-server",
      });
      // #104713: the summary must ship only the projected fields; the runtime
      // synthetic-auth object also carries the raw credential and must never
      // reach the JSON payload.
      expect(
        Object.keys(requireRecord(codexProvider.syntheticAuth, "codex synthetic auth")),
      ).toStrictEqual(["value", "source"]);
      expect(JSON.stringify(payload)).not.toContain("codex-runtime-token");
      expectRecordFields(requireRecord(codexProvider.effective, "codex effective auth"), {
        kind: "synthetic",
        detail: "codex-app-server",
      });
      expect(syntheticProbeProviders).toStrictEqual(["codex"]);
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

  it("passes the canonical merged provider config to synthetic auth plugins", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalSyntheticRefs =
      mocks.resolveRuntimeSyntheticAuthProviderRefs.getMockImplementation();
    const originalResolveSyntheticAuth =
      mocks.resolveProviderSyntheticAuthWithPlugin.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "fixture/demo", fallbacks: [] },
          models: { "fixture/demo": {} },
        },
      },
      models: {
        providers: {
          fixture: { baseUrl: "https://fixture.example/v1", models: [] },
          " fixture ": {
            auth: "api-key",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "FIXTURE_API_KEY" },
          },
        },
      },
      env: { shellEnv: { enabled: false } },
    });
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["fixture"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);

      expect(mocks.resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "fixture",
          context: expect.objectContaining({
            providerConfig: expect.objectContaining({
              auth: "api-key",
              api: "openai-completions",
              apiKey: { source: "env", provider: "default", id: "FIXTURE_API_KEY" },
              baseUrl: "https://fixture.example/v1",
              models: [],
            }),
          }),
        }),
      );
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalSyntheticRefs) {
        mocks.resolveRuntimeSyntheticAuthProviderRefs.mockImplementation(originalSyntheticRefs);
      } else {
        mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue([]);
      }
      if (originalResolveSyntheticAuth) {
        mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
          originalResolveSyntheticAuth,
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
      expect(payload.auth.missingProvidersInUse).toEqual([]);
      expect(payload.auth.modelRouteIssues).toEqual([
        expect.objectContaining({ kind: "indeterminate", provider: "codex" }),
      ]);
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
    const originalLookupImpl = mocks.resolveProviderEnvAuthLookupMaps.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();

    mocks.listProviderEnvAuthLookupKeys.mockReturnValue(["workspace-cloud"]);
    mocks.resolveProviderEnvAuthLookupMaps.mockReturnValue({
      aliasMap: { "codex-cli": "openai" },
      envCandidateMap: {},
      authEvidenceMap: {
        "workspace-cloud": [
          {
            type: "local-file-with-env",
            credentialMarker: "workspace-cloud-local-credentials",
            source: "workspace cloud credentials",
          },
        ],
      },
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
      if (originalLookupImpl) {
        mocks.resolveProviderEnvAuthLookupMaps.mockImplementation(originalLookupImpl);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
