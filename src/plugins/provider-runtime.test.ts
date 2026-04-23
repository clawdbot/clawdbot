import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
  expectedAugmentedOpenaiCodexCatalogEntries,
} from "./provider-runtime.test-support.js";
import type {
  AnyAgentTool,
  ProviderExternalAuthProfile,
  ProviderNormalizeToolSchemasContext,
  ProviderPlugin,
  ProviderSanitizeReplayHistoryContext,
  ProviderValidateReplayTurnsContext,
} from "./types.js";

type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type IsPluginProvidersLoadInFlight =
  typeof import("./providers.runtime.js").isPluginProvidersLoadInFlight;
type ResolveCatalogHookProviderPluginIds =
  typeof import("./providers.js").resolveCatalogHookProviderPluginIds;
type ResolveExternalAuthProfileCompatFallbackPluginIds =
  typeof import("./providers.js").resolveExternalAuthProfileCompatFallbackPluginIds;
type ResolveExternalAuthProfileProviderPluginIds =
  typeof import("./providers.js").resolveExternalAuthProfileProviderPluginIds;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>((_) => [] as ProviderPlugin[]);
const isPluginProvidersLoadInFlightMock = vi.fn<IsPluginProvidersLoadInFlight>((_) => false);
const resolveCatalogHookProviderPluginIdsMock = vi.fn<ResolveCatalogHookProviderPluginIds>(
  (_) => [] as string[],
);
const resolveExternalAuthProfileCompatFallbackPluginIdsMock =
  vi.fn<ResolveExternalAuthProfileCompatFallbackPluginIds>((_) => [] as string[]);
const resolveExternalAuthProfileProviderPluginIdsMock =
  vi.fn<ResolveExternalAuthProfileProviderPluginIds>((_) => [] as string[]);
const providerRuntimeWarnMock = vi.fn();

let augmentModelCatalogWithProviderPlugins: typeof import("./provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let buildProviderAuthDoctorHintWithPlugin: typeof import("./provider-runtime.js").buildProviderAuthDoctorHintWithPlugin;
let buildProviderMissingAuthMessageWithPlugin: typeof import("./provider-runtime.js").buildProviderMissingAuthMessageWithPlugin;
let buildProviderUnknownModelHintWithPlugin: typeof import("./provider-runtime.js").buildProviderUnknownModelHintWithPlugin;
let applyProviderNativeStreamingUsageCompatWithPlugin: typeof import("./provider-runtime.js").applyProviderNativeStreamingUsageCompatWithPlugin;
let applyProviderConfigDefaultsWithPlugin: typeof import("./provider-runtime.js").applyProviderConfigDefaultsWithPlugin;
let formatProviderAuthProfileApiKeyWithPlugin: typeof import("./provider-runtime.js").formatProviderAuthProfileApiKeyWithPlugin;
let classifyProviderFailoverReasonWithPlugin: typeof import("./provider-runtime.js").classifyProviderFailoverReasonWithPlugin;
let matchesProviderContextOverflowWithPlugin: typeof import("./provider-runtime.js").matchesProviderContextOverflowWithPlugin;
let normalizeProviderConfigWithPlugin: typeof import("./provider-runtime.js").normalizeProviderConfigWithPlugin;
let normalizeProviderModelIdWithPlugin: typeof import("./provider-runtime.js").normalizeProviderModelIdWithPlugin;
let applyProviderResolvedModelCompatWithPlugins: typeof import("./provider-runtime.js").applyProviderResolvedModelCompatWithPlugins;
let applyProviderResolvedTransportWithPlugin: typeof import("./provider-runtime.js").applyProviderResolvedTransportWithPlugin;
let normalizeProviderTransportWithPlugin: typeof import("./provider-runtime.js").normalizeProviderTransportWithPlugin;
let prepareProviderExtraParams: typeof import("./provider-runtime.js").prepareProviderExtraParams;
let resolveProviderConfigApiKeyWithPlugin: typeof import("./provider-runtime.js").resolveProviderConfigApiKeyWithPlugin;
let resolveProviderStreamFn: typeof import("./provider-runtime.js").resolveProviderStreamFn;
let resolveProviderCacheTtlEligibility: typeof import("./provider-runtime.js").resolveProviderCacheTtlEligibility;
let resolveProviderBinaryThinking: typeof import("./provider-runtime.js").resolveProviderBinaryThinking;
let resolveProviderBuiltInModelSuppression: typeof import("./provider-runtime.js").resolveProviderBuiltInModelSuppression;
let createProviderEmbeddingProvider: typeof import("./provider-runtime.js").createProviderEmbeddingProvider;
let resolveProviderDefaultThinkingLevel: typeof import("./provider-runtime.js").resolveProviderDefaultThinkingLevel;
let resolveProviderModernModelRef: typeof import("./provider-runtime.js").resolveProviderModernModelRef;
let resolveProviderReasoningOutputModeWithPlugin: typeof import("./provider-runtime.js").resolveProviderReasoningOutputModeWithPlugin;
let resolveProviderReplayPolicyWithPlugin: typeof import("./provider-runtime.js").resolveProviderReplayPolicyWithPlugin;
let resolveProviderSystemPromptContribution: typeof import("./provider-runtime.js").resolveProviderSystemPromptContribution;
let resolveExternalAuthProfilesWithPlugins: typeof import("./provider-runtime.js").resolveExternalAuthProfilesWithPlugins;
let resolveProviderSyntheticAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderSyntheticAuthWithPlugin;
let shouldDeferProviderSyntheticProfileAuthWithPlugin: typeof import("./provider-runtime.js").shouldDeferProviderSyntheticProfileAuthWithPlugin;
let sanitizeProviderReplayHistoryWithPlugin: typeof import("./provider-runtime.js").sanitizeProviderReplayHistoryWithPlugin;
let resolveProviderUsageSnapshotWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageSnapshotWithPlugin;
let resolveProviderUsageAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageAuthWithPlugin;
let resolveProviderXHighThinking: typeof import("./provider-runtime.js").resolveProviderXHighThinking;
let normalizeProviderToolSchemasWithPlugin: typeof import("./provider-runtime.js").normalizeProviderToolSchemasWithPlugin;
let inspectProviderToolSchemasWithPlugin: typeof import("./provider-runtime.js").inspectProviderToolSchemasWithPlugin;
let normalizeProviderResolvedModelWithPlugin: typeof import("./provider-runtime.js").normalizeProviderResolvedModelWithPlugin;
let prepareProviderDynamicModel: typeof import("./provider-runtime.js").prepareProviderDynamicModel;
let prepareProviderRuntimeAuth: typeof import("./provider-runtime.js").prepareProviderRuntimeAuth;
let resetProviderRuntimeHookCacheForTest: typeof import("./provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let refreshProviderOAuthCredentialWithPlugin: typeof import("./provider-runtime.js").refreshProviderOAuthCredentialWithPlugin;
let resolveProviderRuntimePlugin: typeof import("./provider-runtime.js").resolveProviderRuntimePlugin;
let providerRuntimeTesting: typeof import("./provider-runtime.js").__testing;
let runProviderDynamicModel: typeof import("./provider-runtime.js").runProviderDynamicModel;
let validateProviderReplayTurnsWithPlugin: typeof import("./provider-runtime.js").validateProviderReplayTurnsWithPlugin;
let wrapProviderStreamFn: typeof import("./provider-runtime.js").wrapProviderStreamFn;

const MODEL: ProviderRuntimeModel = {
  id: "demo-model",
  name: "Demo Model",
  api: "openai-responses",
  provider: "demo",
  baseUrl: "https://api.example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
const DEMO_PROVIDER_ID = "demo";
const EMPTY_MODEL_REGISTRY = { find: () => null } as never;
const DEMO_REPLAY_MESSAGES: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
const DEMO_SANITIZED_MESSAGE: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "sanitized" }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
};
const DEMO_TOOL = {
  name: "demo-tool",
  label: "Demo tool",
  description: "Demo tool",
  parameters: { type: "object", properties: {} },
  execute: vi.fn(async () => ({ content: [], details: undefined })),
} as unknown as AnyAgentTool;

function createOpenAiCatalogProviderPlugin(
  overrides: Partial<ProviderPlugin> = {},
): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    auth: [],
    suppressBuiltInModel: ({ provider, modelId }) =>
      (provider === "openai" || provider === "azure-openai-responses") &&
      modelId === "gpt-5.3-codex-spark"
        ? { suppress: true, errorMessage: "openai-codex/gpt-5.3-codex-spark" }
        : undefined,
    augmentModelCatalog: () => [
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ],
    ...overrides,
  };
}

function expectProviderRuntimePluginLoad(params: { provider: string; expectedPluginId?: string }) {
  const plugin = resolveProviderRuntimePlugin({ provider: params.provider });

  expect(plugin?.id).toBe(params.expectedPluginId);
  expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
    expect.objectContaining({
      providerRefs: [params.provider],
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    }),
  );
}

function createDemoRuntimeContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    modelId: MODEL.id,
    ...overrides,
  };
}

function createDemoProviderContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    ...overrides,
  };
}

function createDemoResolvedModelContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string; model: ProviderRuntimeModel } {
  return createDemoRuntimeContext({
    model: MODEL,
    ...overrides,
  });
}

function expectCalledOnce(...mocks: Array<{ mock: { calls: unknown[] } }>) {
  for (const mockFn of mocks) {
    expect(mockFn).toHaveBeenCalledTimes(1);
  }
}

function expectResolvedValues(
  cases: ReadonlyArray<{
    actual: () => unknown;
    expected: unknown;
  }>,
) {
  cases.forEach(({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
}

async function expectResolvedMatches(
  cases: ReadonlyArray<{
    actual: () => Promise<unknown>;
    expected: Record<string, unknown>;
  }>,
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toMatchObject(expected);
    }),
  );
}

async function expectResolvedAsyncValues(
  cases: ReadonlyArray<{
    actual: () => Promise<unknown>;
    expected: unknown;
  }>,
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toEqual(expected);
    }),
  );
}

describe("provider-runtime", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./provider-public-artifacts.js", () => ({
      resolveBundledProviderPolicySurface: () => null,
    }));
    vi.doMock("./providers.js", () => ({
      resolveCatalogHookProviderPluginIds: (params: unknown) =>
        resolveCatalogHookProviderPluginIdsMock(params as never),
      resolveExternalAuthProfileCompatFallbackPluginIds: (params: unknown) =>
        resolveExternalAuthProfileCompatFallbackPluginIdsMock(params as never),
      resolveExternalAuthProfileProviderPluginIds: (params: unknown) =>
        resolveExternalAuthProfileProviderPluginIdsMock(params as never),
    }));
    vi.doMock("./providers.runtime.js", () => ({
      resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
      isPluginProvidersLoadInFlight: (params: unknown) =>
        isPluginProvidersLoadInFlightMock(params as never),
    }));
    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: providerRuntimeWarnMock,
        error: vi.fn(),
      }),
    }));
    ({
      augmentModelCatalogWithProviderPlugins,
      buildProviderAuthDoctorHintWithPlugin,
      buildProviderMissingAuthMessageWithPlugin,
      buildProviderUnknownModelHintWithPlugin,
      applyProviderNativeStreamingUsageCompatWithPlugin,
      applyProviderConfigDefaultsWithPlugin,
      applyProviderResolvedModelCompatWithPlugins,
      applyProviderResolvedTransportWithPlugin,
      classifyProviderFailoverReasonWithPlugin,
      formatProviderAuthProfileApiKeyWithPlugin,
      matchesProviderContextOverflowWithPlugin,
      normalizeProviderConfigWithPlugin,
      normalizeProviderModelIdWithPlugin,
      normalizeProviderTransportWithPlugin,
      prepareProviderExtraParams,
      resolveProviderConfigApiKeyWithPlugin,
      resolveProviderStreamFn,
      resolveProviderCacheTtlEligibility,
      resolveProviderBinaryThinking,
      resolveProviderBuiltInModelSuppression,
      createProviderEmbeddingProvider,
      resolveProviderDefaultThinkingLevel,
      resolveProviderModernModelRef,
      resolveProviderReasoningOutputModeWithPlugin,
      resolveProviderReplayPolicyWithPlugin,
      resolveProviderSystemPromptContribution,
      resolveExternalAuthProfilesWithPlugins,
      resolveProviderSyntheticAuthWithPlugin,
      shouldDeferProviderSyntheticProfileAuthWithPlugin,
      sanitizeProviderReplayHistoryWithPlugin,
      resolveProviderUsageSnapshotWithPlugin,
      resolveProviderUsageAuthWithPlugin,
      resolveProviderXHighThinking,
      normalizeProviderToolSchemasWithPlugin,
      inspectProviderToolSchemasWithPlugin,
      normalizeProviderResolvedModelWithPlugin,
      prepareProviderDynamicModel,
      prepareProviderRuntimeAuth,
      resetProviderRuntimeHookCacheForTest,
      refreshProviderOAuthCredentialWithPlugin,
      resolveProviderRuntimePlugin,
      __testing: providerRuntimeTesting,
      runProviderDynamicModel,
      validateProviderReplayTurnsWithPlugin,
      wrapProviderStreamFn,
    } = await import("./provider-runtime.js"));
  });

  beforeEach(() => {
    resetProviderRuntimeHookCacheForTest();
    providerRuntimeTesting.resetExternalAuthFallbackWarningCacheForTest();
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(false);
    resolveCatalogHookProviderPluginIdsMock.mockReset();
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue([]);
    resolveExternalAuthProfileCompatFallbackPluginIdsMock.mockReset();
    resolveExternalAuthProfileCompatFallbackPluginIdsMock.mockReturnValue([]);
    resolveExternalAuthProfileProviderPluginIdsMock.mockReset();
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue([]);
    providerRuntimeWarnMock.mockReset();
  });

  it("matches providers by alias for runtime hook lookup", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openrouter",
        label: "OpenRouter",
        aliases: ["Open Router"],
        auth: [],
      },
    ]);

    expectProviderRuntimePluginLoad({
      provider: "Open Router",
      expectedPluginId: "openrouter",
    });
  });

  it("matches providers by hook alias for runtime hook lookup", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        hookAliases: ["claude-cli"],
        auth: [],
      },
    ]);

    expectProviderRuntimePluginLoad({
      provider: "claude-cli",
      expectedPluginId: "anthropic",
    });
  });

  it("normalizes plugin scopes in provider hook cache keys", () => {
    const base = {
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      providerRefs: ["demo"],
    };

    expect(
      providerRuntimeTesting.buildHookProviderCacheKey({
        ...base,
        onlyPluginIds: [" beta ", "alpha", "beta"],
      }),
    ).toBe(
      providerRuntimeTesting.buildHookProviderCacheKey({
        ...base,
        onlyPluginIds: ["alpha", "beta"],
      }),
    );
  });

  it("skips provider runtime loading when no plugin declares external auth hooks", () => {
    expect(
      resolveExternalAuthProfilesWithPlugins({
        env: process.env,
        context: {
          env: process.env,
          store: { version: 1, profiles: {} },
        },
      }),
    ).toEqual([]);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("warns once with a log-safe plugin id for undeclared external auth fallback plugins", () => {
    const unsafePluginId = "legacy-provider\nWARN forged";
    resolveExternalAuthProfileCompatFallbackPluginIdsMock.mockReturnValue([unsafePluginId]);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "legacy-provider",
        pluginId: unsafePluginId,
        label: "Legacy Provider",
        auth: [],
        resolveExternalOAuthProfiles: () => [
          {
            profileId: "legacy-provider:external",
            credential: {
              type: "oauth",
              provider: "legacy-provider",
              access: "access",
              refresh: "refresh",
              expires: Date.now() + 60_000,
            },
          },
        ],
      },
    ]);

    for (let i = 0; i < 2; i += 1) {
      expect(
        resolveExternalAuthProfilesWithPlugins({
          env: process.env,
          context: {
            env: process.env,
            store: { version: 1, profiles: {} },
          },
        }),
      ).toEqual([
        expect.objectContaining({
          profileId: "legacy-provider:external",
        }),
      ]);
    }

    expect(providerRuntimeWarnMock).toHaveBeenCalledTimes(1);
    const warning = String(providerRuntimeWarnMock.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain('Provider plugin "legacy-providerWARN forged"');
    expect(warning).not.toContain("\n");
  });

  it("does not warn for declared external auth plugins with different provider ids", () => {
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue(["demo-plugin"]);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "demo-provider",
        pluginId: "demo-plugin",
        label: "Demo Provider",
        auth: [],
        resolveExternalAuthProfiles: () => [
          {
            profileId: "demo-provider:external",
            credential: {
              type: "oauth",
              provider: "demo-provider",
              access: "access",
              refresh: "refresh",
              expires: Date.now() + 60_000,
            },
          },
        ],
      },
    ]);

    expect(
      resolveExternalAuthProfilesWithPlugins({
        env: process.env,
        context: {
          env: process.env,
          store: { version: 1, profiles: {} },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        profileId: "demo-provider:external",
      }),
    ]);
    expect(providerRuntimeWarnMock).not.toHaveBeenCalled();
  });

  it("returns provider-prepared runtime auth for the matched provider", async () => {
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: DEMO_PROVIDER_ID,
        label: "Demo",
        auth: [],
        prepareRuntimeAuth,
      },
    ]);

    await expect(
      prepareProviderRuntimeAuth({
        provider: DEMO_PROVIDER_ID,
        context: {
          config: undefined,
          workspaceDir: "/tmp/demo-workspace",
          env: process.env,
          provider: DEMO_PROVIDER_ID,
          modelId: MODEL.id,
          model: MODEL,
          apiKey: "raw-token",
          authMode: "token",
        },
      }),
    ).resolves.toEqual({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    });
    expect(prepareRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "raw-token",
        modelId: MODEL.id,
        provider: DEMO_PROVIDER_ID,
      }),
    );
  });

  it("returns no runtime plugin when the provider has no owning plugin", () => {
    expectProviderRuntimePluginLoad({
      provider: "anthropic",
    });
  });

  it("applies the shared GPT-5 prompt overlay for any provider", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("respects the shared GPT-5 prompt overlay personality config", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "opencode",
      config: {
        agents: {
          defaults: {
            promptOverlays: {
              gpt5: { personality: "off" },
            },
          },
        },
      },
      context: {
        provider: "opencode",
        modelId: "gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("does not apply the shared GPT-5 prompt overlay to non-GPT-5 models", () => {
    expect(
      resolveProviderSystemPromptContribution({
        provider: "openrouter",
        context: {
          provider: "openrouter",
          modelId: "openai/gpt-4.1",
          promptMode: "full",
        } as never,
      }),
    ).toBeUndefined();
  });

  it("can normalize model ids through provider aliases without changing ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        hookAliases: ["google-vertex"],
        auth: [],
        normalizeModelId: ({ modelId }) => modelId.replace("flash-lite", "flash-lite-preview"),
      },
    ]);

    expect(
      normalizeProviderModelIdWithPlugin({
        provider: "google-vertex",
        context: {
          provider: "google-vertex",
          modelId: "gemini-3.1-flash-lite",
        },
      }),
    ).toBe("gemini-3.1-flash-lite-preview");
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("resolves config hooks through hook-only aliases without changing provider surfaces", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        hookAliases: ["google-antigravity"],
        auth: [],
        normalizeConfig: ({ providerConfig }) => ({
          ...providerConfig,
          baseUrl: "https://normalized.example.com/v1",
        }),
      },
    ]);

    expect(
      normalizeProviderConfigWithPlugin({
        provider: "google-antigravity",
        context: {
          provider: "google-antigravity",
          providerConfig: {
            baseUrl: "https://example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });
  });

  it("resolves provider config defaults through owner plugins", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        applyConfigDefaults: ({ config }) => ({
          ...config,
          agents: {
            defaults: {
              heartbeat: { every: "1h" },
            },
          },
        }),
      },
    ]);

    expect(
      applyProviderConfigDefaultsWithPlugin({
        provider: "anthropic",
        context: {
          provider: "anthropic",
          env: {},
          config: {},
        },
      }),
    ).toMatchObject({
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
          },
        },
      },
    });
  });

  it("resolves failover classification through hook-only aliases", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI",
        hookAliases: ["azure-openai-responses"],
        auth: [],
        matchesContextOverflowError: ({ errorMessage }) =>
          /\bcontent_filter\b.*\btoo long\b/i.test(errorMessage),
        classifyFailoverReason: ({ errorMessage }) =>
          /\bquota exceeded\b/i.test(errorMessage) ? "rate_limit" : undefined,
      },
    ]);

    expect(
      matchesProviderContextOverflowWithPlugin({
        provider: "azure-openai-responses",
        context: {
          provider: "azure-openai-responses",
          errorMessage: "content_filter prompt too long",
        },
      }),
    ).toBe(true);
    expect(
      classifyProviderFailoverReasonWithPlugin({
        provider: "azure-openai-responses",
        context: {
          provider: "azure-openai-responses",
          errorMessage: "quota exceeded",
        },
      }),
    ).toBe("rate_limit");
  });

  it("resolves stream wrapper hooks through hook-only aliases without provider ownership", () => {
    const wrappedStreamFn = vi.fn();
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI",
        hookAliases: ["azure-openai-responses"],
        auth: [],
        wrapStreamFn: ({ streamFn }) => streamFn ?? wrappedStreamFn,
      },
    ]);

    expect(
      wrapProviderStreamFn({
        provider: "azure-openai-responses",
        context: createDemoResolvedModelContext({
          provider: "azure-openai-responses",
          streamFn: wrappedStreamFn,
        }),
      }),
    ).toBe(wrappedStreamFn);
  });

  it("normalizes transport hooks without needing provider ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        auth: [],
        normalizeTransport: ({ api, baseUrl }) =>
          api === "google-generative-ai" && baseUrl === "https://generativelanguage.googleapis.com"
            ? {
                api,
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              }
            : undefined,
      },
    ]);

    expect(
      normalizeProviderTransportWithPlugin({
        provider: "google-paid",
        context: {
          provider: "google-paid",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("invalidates cached runtime providers when config mutates in place", () => {
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    } as { plugins: { entries: { demo: { enabled: boolean } } } };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const runtimeConfig = params?.config as typeof config | undefined;
      const enabled = runtimeConfig?.plugins?.entries?.demo?.enabled === true;
      return enabled
        ? [
            {
              id: DEMO_PROVIDER_ID,
              label: "Demo",
              auth: [],
            },
          ]
        : [];
    });

    expect(
      resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      }),
    ).toBeUndefined();

    config.plugins.entries.demo.enabled = true;

    expect(
      resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      }),
    ).toMatchObject({
      id: DEMO_PROVIDER_ID,
    });
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches runtime hooks for the matched provider", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue(["demo"]);
    const prepareDynamicModel = vi.fn(async () => undefined);
    const createStreamFn = vi.fn(() => vi.fn());
    const createEmbeddingProvider = vi.fn(async () => ({
      id: "demo",
      model: "demo-embed",
      embedQuery: async () => [1, 0, 0],
      embedBatch: async () => [[1, 0, 0]],
      client: { token: "embed-token" },
    }));
    const buildReplayPolicy = vi.fn(() => ({
      sanitizeMode: "full" as const,
      toolCallIdMode: "strict9" as const,
      allowSyntheticToolResults: true,
    }));
    const sanitizeReplayHistory = vi.fn(
      async ({
        messages,
      }: Pick<ProviderSanitizeReplayHistoryContext, "messages">): Promise<AgentMessage[]> => [
        ...messages,
        DEMO_SANITIZED_MESSAGE,
      ],
    );
    const validateReplayTurns = vi.fn(
      async ({
        messages,
      }: Pick<ProviderValidateReplayTurnsContext, "messages">): Promise<AgentMessage[]> => messages,
    );
    const normalizeToolSchemas = vi.fn(
      ({ tools }: Pick<ProviderNormalizeToolSchemasContext, "tools">): AnyAgentTool[] => tools,
    );
    const inspectToolSchemas = vi.fn(() => [] as { toolName: string; violations: string[] }[]);
    const resolveReasoningOutputMode = vi.fn(() => "tagged" as const);
    const resolveSyntheticAuth = vi.fn(() => ({
      apiKey: "demo-local",
      source: "models.providers.demo (synthetic local key)",
      mode: "api-key" as const,
    }));
    const shouldDeferSyntheticProfileAuth = vi.fn(
      ({ resolvedApiKey }: { resolvedApiKey?: string }) => resolvedApiKey === "demo-local",
    );
    const buildUnknownModelHint = vi.fn(
      ({ modelId }: { modelId: string }) => `Use demo setup for ${modelId}`,
    );
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    const refreshOAuth = vi.fn(async (cred) => ({
      ...cred,
      access: "refreshed-access-token",
    }));
    const resolveUsageAuth = vi.fn(async () => ({
      token: "usage-token",
      accountId: "usage-account",
    }));
    const fetchUsageSnapshot = vi.fn(async () => ({
      provider: "zai" as const,
      displayName: "Demo",
      windows: [{ label: "Day", usedPercent: 25 }],
    }));
    resolvePluginProvidersMock.mockImplementation((_params: unknown) => {
      return [
        {
          id: DEMO_PROVIDER_ID,
          label: "Demo",
          auth: [],
          normalizeConfig: ({ providerConfig }) => ({
            ...providerConfig,
            baseUrl: "https://normalized.example.com/v1",
          }),
          normalizeTransport: ({ api, baseUrl }) => ({
            api,
            baseUrl: baseUrl ? `${baseUrl}/normalized` : undefined,
          }),
          normalizeModelId: ({ modelId }) => modelId.replace("-legacy", ""),
          resolveDynamicModel: () => MODEL,
          prepareDynamicModel,
          applyNativeStreamingUsageCompat: ({ providerConfig }) => ({
            ...providerConfig,
            compat: { supportsUsageInStreaming: true },
          }),
          buildReplayPolicy,
          sanitizeReplayHistory,
          validateReplayTurns,
          normalizeToolSchemas,
          inspectToolSchemas,
          resolveReasoningOutputMode,
          prepareExtraParams: ({ extraParams }) => ({
            ...extraParams,
            transport: "auto",
          }),
          createStreamFn,
          wrapStreamFn: ({ streamFn, model }) => {
            expect(model).toMatchObject(MODEL);
            return streamFn;
          },
          createEmbeddingProvider,
          resolveSyntheticAuth,
          resolveExternalAuthProfiles: ({ store }): ProviderExternalAuthProfile[] =>
            store.profiles["demo:managed"]
              ? []
              : [
                  {
                    persistence: "runtime-only",
                    profileId: "demo:managed",
                    credential: {
                      type: "oauth",
                      provider: DEMO_PROVIDER_ID,
                      access: "external-access",
                      refresh: "external-refresh",
                      expires: Date.now() + 60_000,
                    },
                  },
                ],
          shouldDeferSyntheticProfileAuth,
          normalizeResolvedModel: ({ model }) => ({
            ...model,
            api: "openai-codex-responses",
          }),
          formatApiKey: (cred) =>
            cred.type === "oauth" ? JSON.stringify({ token: cred.access }) : "",
          refreshOAuth,
          resolveConfigApiKey: () => "DEMO_PROFILE",
          buildAuthDoctorHint: ({ provider, profileId }) =>
            provider === "demo" ? `Repair ${profileId}` : undefined,
          prepareRuntimeAuth,
          resolveUsageAuth,
          fetchUsageSnapshot,
          isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
          isBinaryThinking: () => true,
          supportsXHighThinking: ({ modelId }) => modelId === "gpt-5.4",
          resolveDefaultThinkingLevel: ({ reasoning }) => (reasoning ? "low" : "off"),
          isModernModelRef: ({ modelId }) => modelId.startsWith("gpt-5"),
        },
        {
          ...createOpenAiCatalogProviderPlugin({
            buildMissingAuthMessage: () =>
              'No API key found for provider "openai". Use openai-codex/gpt-5.4.',
            buildUnknownModelHint,
          }),
        } as ProviderPlugin,
      ];
    });

    expect(
      runProviderDynamicModel({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toMatchObject(MODEL);

    expect(
      normalizeProviderModelIdWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          modelId: "demo-model-legacy",
        },
      }),
    ).toBe("demo-model");

    expect(
      normalizeProviderTransportWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          api: "openai-completions",
          baseUrl: "https://demo.example.com",
        },
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://demo.example.com/normalized",
    });

    expect(
      normalizeProviderConfigWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            baseUrl: "https://demo.example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });

    expect(
      applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            baseUrl: "https://demo.example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      compat: { supportsUsageInStreaming: true },
    });

    expect(
      resolveProviderConfigApiKeyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          env: { DEMO_PROFILE: "default" } as NodeJS.ProcessEnv,
        },
      }),
    ).toBe("DEMO_PROFILE");

    await prepareProviderDynamicModel({
      provider: DEMO_PROVIDER_ID,
      context: createDemoRuntimeContext({
        modelRegistry: EMPTY_MODEL_REGISTRY,
      }),
    });

    expect(
      resolveProviderReplayPolicyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
        }),
      }),
    ).toMatchObject({
      sanitizeMode: "full",
      toolCallIdMode: "strict9",
      allowSyntheticToolResults: true,
    });

    expect(
      resolveProviderReasoningOutputModeWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
        }),
      }),
    ).toBe("tagged");

    expect(
      prepareProviderExtraParams({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          extraParams: { temperature: 0.3 },
        }),
      }),
    ).toMatchObject({
      temperature: 0.3,
      transport: "auto",
    });

    expect(
      resolveProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeTypeOf("function");

    await expectResolvedMatches([
      {
        actual: () =>
          createProviderEmbeddingProvider({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              config: {} as never,
              model: "demo-embed",
            }),
          }),
        expected: {
          id: "demo",
          model: "demo-embed",
          client: { token: "embed-token" },
        },
      },
      {
        actual: () =>
          prepareProviderRuntimeAuth({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoResolvedModelContext({
              env: process.env,
              apiKey: "source-token",
              authMode: "api-key",
            }),
          }),
        expected: {
          apiKey: "runtime-token",
          baseUrl: "https://runtime.example.com/v1",
          expiresAt: 123,
        },
      },
      {
        actual: () =>
          refreshProviderOAuthCredentialWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              type: "oauth",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            }),
          }),
        expected: {
          access: "refreshed-access-token",
        },
      },
      {
        actual: () =>
          resolveProviderUsageAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              resolveApiKeyFromConfigAndStore: () => "source-token",
              resolveOAuthToken: async () => null,
            }),
          }),
        expected: {
          token: "usage-token",
          accountId: "usage-account",
        },
      },
      {
        actual: () =>
          resolveProviderUsageSnapshotWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              token: "usage-token",
              timeoutMs: 5_000,
              fetchFn: vi.fn() as never,
            }),
          }),
        expected: {
          provider: "zai",
          windows: [{ label: "Day", usedPercent: 25 }],
        },
      },
      {
        actual: () =>
          sanitizeProviderReplayHistoryWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoResolvedModelContext({
              modelApi: MODEL.api,
              sessionId: "session-1",
              messages: DEMO_REPLAY_MESSAGES,
            }),
          }),
        expected: {
          1: DEMO_SANITIZED_MESSAGE,
        },
      },
      {
        actual: () =>
          validateProviderReplayTurnsWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoResolvedModelContext({
              modelApi: MODEL.api,
              sessionId: "session-1",
              messages: DEMO_REPLAY_MESSAGES,
            }),
          }),
        expected: {
          0: DEMO_REPLAY_MESSAGES[0],
        },
      },
    ]);

    expect(
      wrapProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          streamFn: vi.fn(),
        }),
      }),
    ).toBeTypeOf("function");

    expect(
      normalizeProviderToolSchemasWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
      }),
    ).toEqual([DEMO_TOOL]);

    expect(
      inspectProviderToolSchemasWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
      }),
    ).toEqual([]);

    expect(
      normalizeProviderResolvedModelWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toMatchObject({
      ...MODEL,
      api: "openai-codex-responses",
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeUndefined();

    expect(
      formatProviderAuthProfileApiKeyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          type: "oauth",
          provider: DEMO_PROVIDER_ID,
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    ).toBe('{"token":"oauth-access"}');

    await expectResolvedAsyncValues([
      {
        actual: () =>
          buildProviderAuthDoctorHintWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              profileId: "demo:default",
              store: { version: 1, profiles: {} },
            }),
          }),
        expected: "Repair demo:default",
      },
    ]);

    expectResolvedValues([
      {
        actual: () =>
          resolveProviderCacheTtlEligibility({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "anthropic/claude-sonnet-4-6",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderBinaryThinking({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "glm-5",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderXHighThinking({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderDefaultThinkingLevel({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
              reasoning: true,
            }),
          }),
        expected: "low",
      },
      {
        actual: () =>
          resolveProviderModernModelRef({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveExternalAuthProfilesWithPlugins({
            env: process.env,
            context: {
              env: process.env,
              store: { version: 1, profiles: {} },
            },
          }),
        expected: [
          {
            persistence: "runtime-only",
            profileId: "demo:managed",
            credential: {
              type: "oauth",
              provider: DEMO_PROVIDER_ID,
              access: "external-access",
              refresh: "external-refresh",
              expires: expect.any(Number),
            },
          },
        ],
      },
      {
        actual: () =>
          resolveProviderSyntheticAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              providerConfig: {
                api: "openai-completions",
                baseUrl: "http://localhost:11434",
                models: [],
              },
            }),
          }),
        expected: {
          apiKey: "demo-local",
          source: "models.providers.demo (synthetic local key)",
          mode: "api-key",
        },
      },
      {
        actual: () =>
          shouldDeferProviderSyntheticProfileAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: {
              provider: DEMO_PROVIDER_ID,
              resolvedApiKey: "demo-local",
            },
          }),
        expected: true,
      },
      {
        actual: () =>
          buildProviderUnknownModelHintWithPlugin({
            provider: "openai",
            env: process.env,
            context: {
              env: process.env,
              provider: "openai",
              modelId: "gpt-5.4",
            },
          }),
        expected: "Use demo setup for gpt-5.4",
      },
    ]);

    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);

    expectCalledOnce(
      buildReplayPolicy,
      prepareDynamicModel,
      sanitizeReplayHistory,
      validateReplayTurns,
      normalizeToolSchemas,
      inspectToolSchemas,
      resolveReasoningOutputMode,
      refreshOAuth,
      resolveSyntheticAuth,
      shouldDeferSyntheticProfileAuth,
      buildUnknownModelHint,
      prepareRuntimeAuth,
      resolveUsageAuth,
      fetchUsageSnapshot,
    );
  });

  it("merges compat contributions from owner and foreign provider plugins", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          id: "openrouter",
          label: "OpenRouter",
          auth: [],
          contributeResolvedModelCompat: () => ({ supportsStrictMode: true }),
        },
        {
          id: "mistral",
          label: "Mistral",
          auth: [],
          contributeResolvedModelCompat: ({ modelId }) =>
            modelId.startsWith("mistralai/") ? { supportsStore: false } : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        provider: "openrouter",
        context: createDemoResolvedModelContext({
          provider: "openrouter",
          modelId: "mistralai/mistral-small-3.2-24b-instruct",
          model: {
            ...MODEL,
            provider: "openrouter",
            id: "mistralai/mistral-small-3.2-24b-instruct",
            compat: { supportsDeveloperRole: false },
          },
        }),
      }),
    ).toMatchObject({
      compat: {
        supportsDeveloperRole: false,
        supportsStrictMode: true,
        supportsStore: false,
      },
    });
  });

  it("applies foreign transport normalization for custom provider hosts", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === "custom-openai" &&
            api === "openai-completions" &&
            baseUrl === "https://api.openai.com/v1"
              ? { api: "openai-responses", baseUrl }
              : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedTransportWithPlugin({
        provider: "custom-openai",
        context: createDemoResolvedModelContext({
          provider: "custom-openai",
          modelId: "gpt-5.4",
          model: {
            ...MODEL,
            provider: "custom-openai",
            id: "gpt-5.4",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
        }),
      }),
    ).toMatchObject({
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("resolves bundled catalog hooks through provider plugins", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      const onlyPluginIds = params?.onlyPluginIds;
      if (!onlyPluginIds || !onlyPluginIds.includes("openai")) {
        return [];
      }
      return [createOpenAiCatalogProviderPlugin()];
    });

    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
    });

    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.4", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.4-pro", name: "GPT-5.2 Pro" },
            { provider: "openai", id: "gpt-5.4-mini", name: "GPT-5 mini" },
            { provider: "openai", id: "gpt-5.4-nano", name: "GPT-5 nano" },
            { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
          ],
        },
      }),
    ).resolves.toEqual(expectedAugmentedOpenaiCodexCatalogEntries);

    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
        activate: false,
        cache: false,
      }),
    );
  });

  it("does not stack-overflow when provider hook resolution reenters the same plugin load", () => {
    let providerLoadInFlight = false;
    isPluginProvidersLoadInFlightMock.mockImplementation(() => providerLoadInFlight);
    resolvePluginProvidersMock.mockImplementation(() => {
      providerLoadInFlight = true;
      try {
        const reentrantResult = normalizeProviderConfigWithPlugin({
          provider: "reentrant-provider",
          context: {
            provider: "reentrant-provider",
            providerConfig: {
              baseUrl: "https://example.com",
              api: "openai-completions",
              models: [],
            },
          },
        });
        expect(reentrantResult).toBeUndefined();
        return [];
      } finally {
        providerLoadInFlight = false;
      }
    });

    const result = normalizeProviderConfigWithPlugin({
      provider: "demo",
      context: {
        provider: "demo",
        providerConfig: { baseUrl: "https://example.com", api: "openai-completions", models: [] },
      },
    });

    expect(result).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cached provider hook results available during a nested provider load", () => {
    const cachedNormalizedConfig: ModelProviderConfig = {
      baseUrl: "https://cached.example.com",
      api: "openai-completions",
      models: [],
    };
    let providerLoadInFlight = false;
    isPluginProvidersLoadInFlightMock.mockImplementation(() => providerLoadInFlight);
    resolvePluginProvidersMock.mockImplementation((params) => {
      const providerRef = params?.providerRefs?.[0];
      if (providerRef === "cached-provider") {
        return [
          {
            id: "cached-provider",
            label: "Cached Provider",
            auth: [],
            normalizeConfig: () => cachedNormalizedConfig,
          },
        ];
      }
      providerLoadInFlight = true;
      try {
        const reentrantResult = normalizeProviderConfigWithPlugin({
          provider: "cached-provider",
          context: {
            provider: "cached-provider",
            providerConfig: {
              baseUrl: "https://example.com",
              api: "openai-completions",
              models: [],
            },
          },
        });
        expect(reentrantResult).toBe(cachedNormalizedConfig);
        return [];
      } finally {
        providerLoadInFlight = false;
      }
    });

    expect(
      normalizeProviderConfigWithPlugin({
        provider: "cached-provider",
        context: {
          provider: "cached-provider",
          providerConfig: { baseUrl: "https://example.com", api: "openai-completions", models: [] },
        },
      }),
    ).toBe(cachedNormalizedConfig);

    expect(
      normalizeProviderConfigWithPlugin({
        provider: "outer-provider",
        context: {
          provider: "outer-provider",
          providerConfig: {
            baseUrl: "https://outer.example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toBeUndefined();

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(3);
  });
});
