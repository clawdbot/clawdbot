import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  expectAugmentedCodexCatalog,
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
type ResolveOwningPluginIdsForProvider =
  typeof import("./providers.js").resolveOwningPluginIdsForProvider;
type ResolveBundledProviderPolicySurface =
  typeof import("./provider-public-artifacts.js").resolveBundledProviderPolicySurface;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>((_) => [] as ProviderPlugin[]);
const isPluginProvidersLoadInFlightMock = vi.fn<IsPluginProvidersLoadInFlight>((_) => false);
const resolveCatalogHookProviderPluginIdsMock = vi.fn<ResolveCatalogHookProviderPluginIds>(
  (_) => [] as string[],
);
const resolveExternalAuthProfileCompatFallbackPluginIdsMock =
  vi.fn<ResolveExternalAuthProfileCompatFallbackPluginIds>((_) => [] as string[]);
const resolveExternalAuthProfileProviderPluginIdsMock =
  vi.fn<ResolveExternalAuthProfileProviderPluginIds>((_) => [] as string[]);
const resolveOwningPluginIdsForProviderMock = vi.fn<ResolveOwningPluginIdsForProvider>(
  (_) => undefined,
);
const resolveBundledProviderPolicySurfaceMock = vi.fn<ResolveBundledProviderPolicySurface>(
  (_) => null,
);
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
let resolveProviderAuthProfileId: typeof import("./provider-runtime.js").resolveProviderAuthProfileId;
let resolveProviderConfigApiKeyWithPlugin: typeof import("./provider-runtime.js").resolveProviderConfigApiKeyWithPlugin;
let resolveProviderExtraParamsForTransport: typeof import("./provider-runtime.js").resolveProviderExtraParamsForTransport;
let resolveProviderFollowupFallbackRoute: typeof import("./provider-runtime.js").resolveProviderFollowupFallbackRoute;
let resolveProviderStreamFn: typeof import("./provider-runtime.js").resolveProviderStreamFn;
let resolveProviderCacheTtlEligibility: typeof import("./provider-runtime.js").resolveProviderCacheTtlEligibility;
let resolveProviderBinaryThinking: typeof import("./provider-runtime.js").resolveProviderBinaryThinking;
let createProviderEmbeddingProvider: typeof import("./provider-runtime.js").createProviderEmbeddingProvider;
let resolveProviderThinkingProfile: typeof import("./provider-runtime.js").resolveProviderThinkingProfile;
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
let refreshProviderOAuthCredentialWithPlugin: typeof import("./provider-runtime.js").refreshProviderOAuthCredentialWithPlugin;
let resolveProviderRuntimePlugin: typeof import("./provider-runtime.js").resolveProviderRuntimePlugin;
let providerRuntimeTesting: typeof import("./provider-runtime.js").__testing;
let runProviderDynamicModel: typeof import("./provider-runtime.js").runProviderDynamicModel;
let validateProviderReplayTurnsWithPlugin: typeof import("./provider-runtime.js").validateProviderReplayTurnsWithPlugin;
let wrapProviderStreamFn: typeof import("./provider-runtime.js").wrapProviderStreamFn;
let createEmptyPluginRegistry: typeof import("./registry.js").createEmptyPluginRegistry;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

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
    augmentModelCatalog: () => [
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
    ],
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }): unknown {
  return mock.mock.calls[0]?.[0];
}

function firstMockStringArg(mock: { mock: { calls: unknown[][] } }, label: string): string {
  const value = firstMockArg(mock);
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectObjectOrArrayFields(value: unknown, fields: Record<string, unknown>) {
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new Error("Expected value to be an object or array");
  }
  const record = value as Record<string, unknown>;
  expectRecordFields(record, fields);
}

function getLastResolvePluginProvidersParams() {
  const calls = resolvePluginProvidersMock.mock.calls;
  return requireRecord(calls[calls.length - 1]?.[0], "provider load params");
}

function expectProviderRuntimePluginLoad(params: { provider: string; expectedPluginId?: string }) {
  const plugin = resolveProviderRuntimePlugin({ provider: params.provider });

  expect(plugin?.id).toBe(params.expectedPluginId);
  expectRecordFields(getLastResolvePluginProvidersParams(), {
    providerRefs: [params.provider],
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
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
      expectObjectOrArrayFields(await actual(), expected);
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
      resolveBundledProviderPolicySurface: (provider: string) =>
        resolveBundledProviderPolicySurfaceMock(provider),
    }));
    vi.doMock("./providers.js", () => ({
      resolveCatalogHookProviderPluginIds: (params: unknown) =>
        resolveCatalogHookProviderPluginIdsMock(params as never),
      resolveExternalAuthProfileCompatFallbackPluginIds: (params: unknown) =>
        resolveExternalAuthProfileCompatFallbackPluginIdsMock(params as never),
      resolveExternalAuthProfileProviderPluginIds: (params: unknown) =>
        resolveExternalAuthProfileProviderPluginIdsMock(params as never),
      resolveOwningPluginIdsForProvider: (params: unknown) =>
        resolveOwningPluginIdsForProviderMock(params as never),
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
      resolveProviderAuthProfileId,
      resolveProviderConfigApiKeyWithPlugin,
      resolveProviderExtraParamsForTransport,
      resolveProviderFollowupFallbackRoute,
      resolveProviderStreamFn,
      resolveProviderCacheTtlEligibility,
      resolveProviderBinaryThinking,
      createProviderEmbeddingProvider,
      resolveProviderThinkingProfile,
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
      refreshProviderOAuthCredentialWithPlugin,
      resolveProviderRuntimePlugin,
      __testing: providerRuntimeTesting,
      runProviderDynamicModel,
      validateProviderReplayTurnsWithPlugin,
      wrapProviderStreamFn,
    } = await import("./provider-runtime.js"));
    ({ createEmptyPluginRegistry } = await import("./registry.js"));
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
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
    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockReturnValue(undefined);
    resolveBundledProviderPolicySurfaceMock.mockReset();
    resolveBundledProviderPolicySurfaceMock.mockReturnValue(null);
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

  it("uses the active startup registry for provider hook lookup", () => {
    const provider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo",
      auth: [],
      prepareExtraParams: ({ extraParams }) => ({
        ...extraParams,
        fromActiveRegistry: true,
      }),
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: DEMO_PROVIDER_ID,
      provider,
      source: "test",
    });
    setActivePluginRegistry(registry, "startup-registry", "gateway-bindable", "/tmp/workspace");

    expect(
      prepareProviderExtraParams({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/workspace",
        context: createDemoRuntimeContext({
          extraParams: {},
        }),
      }),
    ).toEqual({
      fromActiveRegistry: true,
    });
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("matches active provider hooks through a custom provider's native api owner", () => {
    const provider: ProviderPlugin = {
      id: "ollama",
      label: "Ollama",
      auth: [],
      createStreamFn: vi.fn(() => vi.fn()),
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "ollama",
      provider,
      source: "test",
    });
    setActivePluginRegistry(registry, "startup-registry", "gateway-bindable", "/tmp/workspace");

    const plugin = resolveProviderRuntimePlugin({
      provider: "ollama-spark",
      workspaceDir: "/tmp/workspace",
      config: {
        models: {
          providers: {
            "ollama-spark": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      } as never,
    });

    expect(plugin?.id).toBe("ollama");
    expect(plugin?.pluginId).toBe("ollama");
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("uses current provider-ref owner plugin config for provider hooks", () => {
    const provider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo",
      auth: [],
    };
    resolveOwningPluginIdsForProviderMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockReturnValue([provider]);
    const firstConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://one.example" } },
        },
      },
    } as OpenClawConfig;
    const secondConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://two.example" } },
        },
      },
    } as OpenClawConfig;

    expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config: firstConfig })).toBe(
      provider,
    );
    expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config: secondConfig })).toBe(
      provider,
    );

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("resolves provider-ref hook loads from current config each time", () => {
    const provider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo",
      auth: [],
    };
    resolveOwningPluginIdsForProviderMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockReturnValue([provider]);
    const firstConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://demo.example" } },
          "active-memory": { enabled: true },
        },
      },
    } as OpenClawConfig;
    const secondConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://demo.example" } },
          "active-memory": { enabled: true, config: { qmd: { searchMode: "fast" } } },
        },
      },
    } as OpenClawConfig;

    expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config: firstConfig })).toBe(
      provider,
    );
    expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config: secondConfig })).toBe(
      provider,
    );

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse runtime provider cache entries across env-resolved plugin roots", () => {
    const firstProvider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo one",
      auth: [],
    };
    const secondProvider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo two",
      auth: [],
    };
    const config = {} as OpenClawConfig;
    const originalHome = process.env.HOME;
    const originalOpenClawHome = process.env.OPENCLAW_HOME;
    try {
      process.env.HOME = "/home/one";
      delete process.env.OPENCLAW_HOME;
      resolvePluginProvidersMock.mockReturnValueOnce([firstProvider]);
      expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config })).toBe(
        firstProvider,
      );

      process.env.HOME = "/home/two";
      resolvePluginProvidersMock.mockReturnValueOnce([secondProvider]);
      expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config })).toBe(
        secondProvider,
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalOpenClawHome;
      }
    }

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse auto-enabled runtime providers for synthetic auth fallback", () => {
    const runtimeProvider: ProviderPlugin = {
      id: DEMO_PROVIDER_ID,
      label: "Demo",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "default-runtime-token",
        source: "default runtime",
        mode: "api-key" as const,
      }),
    };
    resolvePluginProvidersMock.mockImplementation((params) =>
      params.applyAutoEnable === false &&
      params.bundledProviderAllowlistCompat === false &&
      params.bundledProviderVitestCompat === false
        ? []
        : [runtimeProvider],
    );

    expect(resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID })).toBe(runtimeProvider);

    expect(
      resolveProviderSyntheticAuthWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(3);
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
    ).toStrictEqual([]);
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
      const [profile] = resolveExternalAuthProfilesWithPlugins({
        env: process.env,
        context: {
          env: process.env,
          store: { version: 1, profiles: {} },
        },
      });
      expect(profile?.profileId).toBe("legacy-provider:external");
    }

    expect(providerRuntimeWarnMock).toHaveBeenCalledTimes(1);
    const warning = firstMockStringArg(providerRuntimeWarnMock, "provider warning");
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

    const [profile] = resolveExternalAuthProfilesWithPlugins({
      env: process.env,
      context: {
        env: process.env,
        store: { version: 1, profiles: {} },
      },
    });
    expect(profile?.profileId).toBe("demo-provider:external");
    expect(providerRuntimeWarnMock).not.toHaveBeenCalled();
  });

  it("resolves catalog hook provider loads when only non-plugin config changes", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "demo",
        label: "Demo",
        auth: [],
        augmentModelCatalog: () => [{ provider: "demo", id: "demo-model", name: "Demo Model" }],
      },
    ]);
    const baseConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const firstConfig = {
      ...baseConfig,
      agents: { defaults: { model: "openai/gpt-5.4" } },
    } as OpenClawConfig;
    const secondConfig = {
      ...baseConfig,
      agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    } as OpenClawConfig;

    expect(
      await augmentModelCatalogWithProviderPlugins({
        config: firstConfig,
        env: process.env,
        context: { config: firstConfig, env: process.env, entries: [] },
      }),
    ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);
    expect(
      await augmentModelCatalogWithProviderPlugins({
        config: secondConfig,
        env: process.env,
        context: { config: secondConfig, env: process.env, entries: [] },
      }),
    ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("resolves catalog hook provider loads when unrelated plugin config changes", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "demo",
        label: "Demo",
        auth: [],
        augmentModelCatalog: () => [{ provider: "demo", id: "demo-model", name: "Demo Model" }],
      },
    ]);
    const firstConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://demo.example" } },
          "active-memory": { enabled: true },
        },
      },
    } as OpenClawConfig;
    const secondConfig = {
      plugins: {
        entries: {
          demo: { enabled: true, config: { endpoint: "https://demo.example" } },
          "active-memory": { enabled: true, config: { qmd: { searchMode: "fast" } } },
        },
      },
    } as OpenClawConfig;

    for (const config of [firstConfig, secondConfig]) {
      expect(
        await augmentModelCatalogWithProviderPlugins({
          config,
          env: process.env,
          context: { config, env: process.env, entries: [] },
        }),
      ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);
    }

    expect(resolveCatalogHookProviderPluginIdsMock).toHaveBeenCalledTimes(2);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
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
    const prepareRuntimeAuthCalls = prepareRuntimeAuth.mock.calls as unknown[][];
    expectRecordFields(requireRecord(prepareRuntimeAuthCalls[0]?.[0], "runtime auth context"), {
      apiKey: "raw-token",
      modelId: MODEL.id,
      provider: DEMO_PROVIDER_ID,
    });
  });

  it("returns no runtime plugin when the provider has no owning plugin", () => {
    expectProviderRuntimePluginLoad({
      provider: "anthropic",
    });
  });

  it("exposes provider-owned transport extra params", () => {
    const extraParamsForTransport = vi.fn((_ctx) => ({
      patch: {
        providerTransportPatch: true,
      },
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: DEMO_PROVIDER_ID,
        label: "Demo",
        auth: [],
        extraParamsForTransport,
      } satisfies ProviderPlugin,
    ]);

    expect(
      resolveProviderExtraParamsForTransport({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          extraParams: { transport: "websocket" },
          transport: "websocket" as const,
        }),
      }),
    ).toEqual({
      patch: {
        providerTransportPatch: true,
      },
    });
    expectRecordFields(
      requireRecord(firstMockArg(extraParamsForTransport), "transport params context"),
      {
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        model: MODEL,
        transport: "websocket",
      },
    );
  });

  it("exposes provider-owned auth profile and fallback route seams", () => {
    const resolveAuthProfileId = vi.fn(() => "profile-b");
    const followupFallbackRoute = vi.fn(() => ({
      route: "dispatcher" as const,
      reason: "origin unavailable",
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: DEMO_PROVIDER_ID,
        label: "Demo",
        auth: [],
        resolveAuthProfileId,
        followupFallbackRoute,
      } satisfies ProviderPlugin,
    ]);

    expect(
      resolveProviderAuthProfileId({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          profileOrder: ["profile-a", "profile-b"],
          authStore: { version: 1, profiles: {}, order: {} },
        }),
      }),
    ).toBe("profile-b");
    expect(
      resolveProviderFollowupFallbackRoute({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          payload: { text: "hello" },
          originRoutable: false,
          dispatcherAvailable: true,
        }),
      }),
    ).toEqual({
      route: "dispatcher",
      reason: "origin unavailable",
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
      "Live chat tone: short, natural, human.",
    );
    expect(contribution?.sectionOverrides?.interaction_style).not.toContain(
      "Use heartbeats to create useful proactive progress",
    );
  });

  it("passes heartbeat trigger context to the shared GPT-5 prompt overlay", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
        trigger: "heartbeat",
      } as never,
    });

    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "Use heartbeats to create useful proactive progress",
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
    expect(contribution?.sectionOverrides).toStrictEqual({});
  });

  it("lets provider-owned prompt overlays compose after the built-in GPT-5 overlay", () => {
    const resolvePromptOverlay = vi.fn((ctx) => ({
      stablePrefix: "provider overlay",
      sectionOverrides: {
        execution_bias: ctx.baseOverlay?.stablePrefix ? "saw built-in overlay" : "missing",
      },
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openrouter",
        label: "OpenRouter",
        auth: [],
        resolvePromptOverlay,
      } satisfies ProviderPlugin,
    ]);

    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.stablePrefix).toContain("provider overlay");
    expect(contribution?.sectionOverrides?.execution_bias).toBe("saw built-in overlay");
    const overlayContext = requireRecord(firstMockArg(resolvePromptOverlay), "overlay context");
    expect(overlayContext.provider).toBe("openrouter");
    expect(overlayContext.modelId).toBe("openai/gpt-5.4");
    expect(
      String(requireRecord(overlayContext.baseOverlay, "base overlay").stablePrefix),
    ).toContain("<persona_latch>");
  });

  it("ignores OpenAI plugin personality fallback for non-OpenAI GPT-5 providers", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      config: {
        plugins: {
          entries: {
            openai: { config: { personality: "off" } },
          },
        },
      },
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "Live chat tone: short, natural, human.",
    );
  });

  it("keeps OpenAI plugin personality fallback for OpenAI-family GPT-5 providers", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "openai-codex",
      config: {
        plugins: {
          entries: {
            openai: { config: { personality: "off" } },
          },
        },
      },
      context: {
        provider: "openai-codex",
        modelId: "gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toStrictEqual({});
  });

  it("keeps OpenAI plugin personality fallback for Azure OpenAI GPT-5 providers", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "azure-openai-responses",
      config: {
        plugins: {
          entries: {
            openai: { config: { personality: "off" } },
          },
        },
      },
      context: {
        provider: "azure-openai-responses",
        modelId: "gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toStrictEqual({});
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
      })?.baseUrl,
    ).toBe("https://normalized.example.com/v1");
  });

  it("does not scan provider plugins after bundled policy surface handles config", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    const normalizeConfig = vi.fn(() => providerConfig);
    resolveBundledProviderPolicySurfaceMock.mockReturnValue({
      normalizeConfig,
    });

    expect(
      normalizeProviderConfigWithPlugin({
        provider: "openai",
        context: {
          provider: "openai",
          providerConfig,
        },
      }),
    ).toBeUndefined();

    expect(normalizeConfig).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("resolves thinking profiles from bundled policy surface before runtime plugins", () => {
    const resolveThinkingProfile = vi.fn(() => ({
      levels: [{ id: "off" as const }],
      defaultLevel: "off" as const,
    }));
    resolveBundledProviderPolicySurfaceMock.mockReturnValue({
      resolveThinkingProfile,
    });

    expect(
      resolveProviderThinkingProfile({
        provider: "xai",
        context: {
          provider: "xai",
          modelId: "grok-4.3",
          reasoning: true,
        },
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });

    expect(resolveThinkingProfile).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
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
    ).toEqual({
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

  it("does not run broad provider-hook scans for reasoning output mode", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      if (params.providerRefs?.includes("mock-openai")) {
        return [];
      }
      throw new Error("unexpected broad provider hook scan");
    });

    expect(
      resolveProviderReasoningOutputModeWithPlugin({
        provider: "mock-openai",
        context: createDemoResolvedModelContext({
          provider: "mock-openai",
          modelId: "gpt-5.5",
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
  });

  it("does not run broad provider-hook scans for auth profile selection", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      if (params.providerRefs?.includes("mock-openai")) {
        return [];
      }
      throw new Error("unexpected broad provider hook scan");
    });

    expect(
      resolveProviderAuthProfileId({
        provider: "mock-openai",
        context: createDemoRuntimeContext({
          provider: "mock-openai",
          modelId: "gpt-5.5",
          profileOrder: [],
          authStore: { version: 1, profiles: {}, order: {} },
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
  });

  it("does not run broad provider-hook scans for transport extra params", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      if (params.providerRefs?.includes("mock-openai")) {
        return [];
      }
      throw new Error("unexpected broad provider hook scan");
    });

    expect(
      resolveProviderExtraParamsForTransport({
        provider: "mock-openai",
        context: createDemoRuntimeContext({
          provider: "mock-openai",
          modelId: "gpt-5.5",
          extraParams: {},
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
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
      })?.id,
    ).toBe(DEMO_PROVIDER_ID);
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
            expect(model).toEqual(MODEL);
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
              'No API key found for provider "openai". Use openai/gpt-5.5.',
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
    ).toEqual(MODEL);

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
      })?.baseUrl,
    ).toBe("https://normalized.example.com/v1");

    const streamingCompatConfig = applyProviderNativeStreamingUsageCompatWithPlugin({
      provider: DEMO_PROVIDER_ID,
      context: {
        provider: DEMO_PROVIDER_ID,
        providerConfig: {
          baseUrl: "https://demo.example.com",
          api: "openai-completions",
          models: [],
        },
      },
    });
    expect(requireRecord(streamingCompatConfig, "streaming compat config").compat).toEqual({
      supportsUsageInStreaming: true,
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
    ).toEqual({
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
    ).toEqual({
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
    ).toStrictEqual([]);

    expect(
      normalizeProviderResolvedModelWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toEqual({
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

    const [externalProfile] = resolveExternalAuthProfilesWithPlugins({
      env: process.env,
      context: {
        env: process.env,
        store: { version: 1, profiles: {} },
      },
    });
    expectRecordFields(requireRecord(externalProfile, "external auth profile"), {
      persistence: "runtime-only",
      profileId: "demo:managed",
    });
    const credential = requireRecord(externalProfile?.credential, "external auth credential");
    expectRecordFields(credential, {
      type: "oauth",
      provider: DEMO_PROVIDER_ID,
      access: "external-access",
      refresh: "external-refresh",
    });
    expect(typeof credential.expires).toBe("number");

    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
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

  it("matches provider hooks through a custom provider's native api owner", () => {
    const ollamaPlugin: ProviderPlugin = {
      id: "ollama",
      label: "Ollama",
      auth: [],
      createStreamFn: vi.fn(() => vi.fn()),
    };
    resolvePluginProvidersMock.mockReturnValue([ollamaPlugin]);

    const plugin = resolveProviderRuntimePlugin({
      provider: "ollama-spark",
      config: {
        models: {
          providers: {
            "ollama-spark": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      } as never,
    });

    expect(plugin).toBe(ollamaPlugin);
    expect(getLastResolvePluginProvidersParams().providerRefs).toEqual(["ollama-spark", "ollama"]);
  });

  it("does not match alias hooks when an exact custom provider declares a foreign api owner", () => {
    const qwenPlugin: ProviderPlugin = {
      id: "qwen",
      label: "Qwen",
      aliases: ["modelstudio"],
      auth: [],
      createStreamFn: vi.fn(() => vi.fn()),
    };
    resolvePluginProvidersMock.mockReturnValue([qwenPlugin]);

    const plugin = resolveProviderRuntimePlugin({
      provider: "modelstudio",
      config: {
        models: {
          providers: {
            modelstudio: {
              api: "openai-completions",
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      } as never,
    });

    expect(plugin).toBeUndefined();
    expect(getLastResolvePluginProvidersParams().providerRefs).toEqual([
      "modelstudio",
      "openai-completions",
    ]);
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
      })?.compat,
    ).toEqual({
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      supportsStore: false,
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
    ).toEqual({
      ...MODEL,
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

    expectRecordFields(getLastResolvePluginProvidersParams(), {
      onlyPluginIds: ["openai"],
      activate: false,
    });
    expect(resolveCatalogHookProviderPluginIdsMock).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
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
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse provider hook results during a nested provider load", () => {
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
        expect(reentrantResult).toBeUndefined();
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

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });
});
