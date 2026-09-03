// Broad coverage for embedded runner model resolution behavior.
import fs from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledPluginPublicSurface } from "../../plugin-sdk/test-helpers/public-surface-loader.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { discoverAuthStorage, discoverModels } from "../agent-model-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../auth-profiles.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../plugin-model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.owner.js";
import { guardModelFixtureAuth } from "./model.fixture.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "model-resolution" });
  auth = guardModelFixtureAuth(state.root);
});
afterEach(async () => {
  try {
    auth.verify();
  } finally {
    auth.spy.mockRestore();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  }
});

const resolveBundledStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveBundledProviderStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveManifestModelCatalogProviderAliasMetadataMock = vi.hoisted(() =>
  vi.fn<
    (params: {
      provider: string;
      cfg?: { models?: { providers?: Record<string, { baseUrl?: string }> } };
    }) => {
      ambiguous?: true;
      provider: string;
      transport?: { api?: "azure-openai-responses"; baseUrl?: string };
    }
  >(),
);
const resolveRuntimeSyntheticAuthProviderRefsMock = vi.hoisted(() => vi.fn((): string[] => []));
const resolveRuntimeExternalAuthProviderRefsMock = vi.hoisted(() => vi.fn((): string[] => []));
const preparedSnapshotState = vi.hoisted(() => ({
  enabled: true,
  getInputs: [] as Array<Record<string, unknown>>,
  snapshots: new Map<string, unknown>(),
  configuredRuntimeModels: [] as PreparedModelRuntimeSnapshot["configuredRuntimeModels"],
  inlineProviderModels: [] as PreparedModelRuntimeSnapshot["inlineProviderModels"],
}));

vi.mock("../../plugins/provider-external-auth.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

vi.mock("../model-suppression.js", () => {
  // Mirrors the canonical manifest-driven suppression in
  // extensions/qwen/openclaw.plugin.json and src/plugins/manifest-model-suppression.ts.
  function isQwenCodingPlanBaseUrl(value: string | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
      return (
        hostname === "coding.dashscope.aliyuncs.com" ||
        hostname === "coding-intl.dashscope.aliyuncs.com"
      );
    } catch {
      return false;
    }
  }

  function resolveConfiguredQwenBaseUrl(config: unknown): string | undefined {
    const providers = (config as { models?: { providers?: Record<string, { baseUrl?: string }> } })
      ?.models?.providers;
    if (!providers) {
      return undefined;
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const normalizedProvider = provider.trim().toLowerCase();
      if (normalizedProvider !== "qwen" && normalizedProvider !== "modelstudio") {
        continue;
      }
      const baseUrl = entry?.baseUrl?.trim();
      if (baseUrl) {
        return baseUrl;
      }
    }
    return undefined;
  }

  function isUnsupportedXaiMultiAgentModel(provider?: string, id?: string): boolean {
    return provider === "xai" && id?.trim().toLowerCase() === "grok-4.20-multi-agent-0309";
  }

  return {
    shouldSuppressBuiltInModelCore: ({
      provider,
      id,
      baseUrl,
      config,
    }: {
      provider?: string;
      id?: string;
      baseUrl?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      if (isUnsupportedXaiMultiAgentModel(provider, id)) {
        return true;
      }
      return (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(baseUrl ?? resolveConfiguredQwenBaseUrl(config))
      );
    },
    shouldUnconditionallySuppress: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return isUnsupportedXaiMultiAgentModel(provider, id);
    },
    buildSuppressedBuiltInModelError: ({
      provider,
      id,
      config,
    }: {
      provider?: string;
      id?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(resolveConfiguredQwenBaseUrl(config))
      ) {
        return "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.";
      }
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
      }
      if (isUnsupportedXaiMultiAgentModel(provider, id)) {
        return "Unknown model: xai/grok-4.20-multi-agent-0309. OpenClaw does not currently support xAI multi-agent models; choose another xAI model. See https://docs.openclaw.ai/providers/xai.";
      }
      return undefined;
    },
  };
});

vi.mock("../prepared-model-runtime.js", async () => {
  const discovery = await import("../agent-model-discovery.js");
  const discoveryContext = await import("../model-discovery-context.js");
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("../prepared-model-runtime.errors.js");
  const createSnapshot = (input: {
    agentId?: string;
    agentDir: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
  }) => {
    const workspaceDir = discoveryContext.resolveModelWorkspaceDir(
      input.config,
      input.workspaceDir,
    );
    const key = `${input.agentId ?? ""}\u0000${input.agentDir}\u0000${workspaceDir ?? ""}`;
    const current = preparedSnapshotState.snapshots.get(key);
    if (current) {
      return current;
    }
    const authStorage = discovery.discoverAuthStorage(input.agentDir);
    const modelRegistry = discovery.discoverModels(authStorage, input.agentDir, {
      ...(input.config ? { config: input.config } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    if (!("fork" in modelRegistry)) {
      Object.assign(modelRegistry, { fork: () => modelRegistry });
    }
    const snapshot = {
      catalogOwner: undefined,
      agentDir: input.agentDir,
      ...(workspaceDir ? { workspaceDir } : {}),
      activeProjectKeys: [],
      config: input.config ?? {},
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: preparedSnapshotState.configuredRuntimeModels,
      inlineProviderModels: preparedSnapshotState.inlineProviderModels,
      createStores: () => ({ authStorage, modelRegistry }),
    };
    preparedSnapshotState.snapshots.set(key, snapshot);
    return snapshot;
  };
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    getPreparedModelRuntimeSnapshot: (input: Parameters<typeof createSnapshot>[0]) => {
      preparedSnapshotState.getInputs.push(input);
      return preparedSnapshotState.enabled ? createSnapshot(input) : undefined;
    },
    loadPreparedModelRuntimeSnapshot: async (input: Parameters<typeof createSnapshot>[0]) =>
      createSnapshot(input),
  };
});

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: resolveRuntimeSyntheticAuthProviderRefsMock,
  resolveRuntimeExternalAuthProviderRefs: resolveRuntimeExternalAuthProviderRefsMock,
}));

vi.mock("./model.static-catalog.js", () => ({
  canonicalizeManifestModelCatalogProviderAlias: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).provider,
  resolveBundledProviderStaticCatalogModel: resolveBundledProviderStaticCatalogModelMock,
  resolveBundledStaticCatalogModel: resolveBundledStaticCatalogModelMock,
  resolveManifestModelCatalogProviderAliasMetadata:
    resolveManifestModelCatalogProviderAliasMetadataMock,
  resolveManifestModelCatalogProviderTransport: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).transport,
}));

type OpenRouterModelCapabilities = NonNullable<
  ReturnType<typeof import("./openrouter-model-capabilities.js").getOpenRouterModelCapabilities>
>;

const mockGetOpenRouterModelCapabilities = vi.fn<
  (modelId: string) => OpenRouterModelCapabilities | undefined
>(() => undefined);
const mockLoadOpenRouterModelCapabilities = vi.fn<(modelId: string) => Promise<void>>(
  async () => {},
);
vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: (modelId: string) => mockGetOpenRouterModelCapabilities(modelId),
  loadOpenRouterModelCapabilities: (modelId: string) =>
    mockLoadOpenRouterModelCapabilities(modelId),
}));

import type { OpenClawConfig, OpenClawConfigInput } from "../../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import { getModelProviderLocalService } from "../provider-local-service.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { applyConfiguredProviderOverrides } from "./model.configured-overrides.js";
import { buildForwardCompatTemplate } from "./model.forward-compat.test-support.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { resolveModelAsync, resolveModelWithRegistry } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeOpenClawConfigFixture,
  makeModel,
  mockDiscoveredModel,
  OPENAI_CODEX_TEMPLATE_MODEL,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  preparedSnapshotState.enabled = true;
  preparedSnapshotState.getInputs.length = 0;
  preparedSnapshotState.snapshots.clear();
  preparedSnapshotState.configuredRuntimeModels = [];
  preparedSnapshotState.inlineProviderModels = [];
  clearRuntimeAuthProfileStoreSnapshots();
  resetMockDiscoverModels(discoverModels);
  vi.mocked(discoverModels).mockClear();
  vi.mocked(discoverAuthStorage).mockClear();
  resolveRuntimeSyntheticAuthProviderRefsMock.mockReset();
  resolveRuntimeSyntheticAuthProviderRefsMock.mockReturnValue([]);
  resolveRuntimeExternalAuthProviderRefsMock.mockReset();
  resolveRuntimeExternalAuthProviderRefsMock.mockReturnValue([]);
  mockGetOpenRouterModelCapabilities.mockReset();
  mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);
  mockLoadOpenRouterModelCapabilities.mockReset();
  mockLoadOpenRouterModelCapabilities.mockResolvedValue();
  resolveBundledStaticCatalogModelMock.mockReset();
  resolveBundledProviderStaticCatalogModelMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockImplementation(({ provider, cfg }) => {
    const normalized = provider.trim().toLowerCase();
    const canonicalProvider =
      normalized === "moonshotai" || normalized === "moonshot-ai" ? "moonshot" : provider;
    const transport =
      provider === "azure-openai-responses" && cfg?.models?.providers?.[provider]?.baseUrl
        ? { api: "azure-openai-responses" as const }
        : undefined;
    return {
      provider: canonicalProvider,
      ...(transport ? { transport } : {}),
    };
  });
});

function createRuntimeHooks() {
  // Runtime hooks emulate provider plugin model discovery, transport
  // normalization, and OpenRouter capability loading without plugin imports.
  return createProviderRuntimeTestMock({
    handledDynamicProviders: [
      "openrouter",
      "github-copilot",
      "openai",
      "openai",
      "anthropic",
      "zai",
    ],
    getOpenRouterModelCapabilities: (modelId: string) =>
      mockGetOpenRouterModelCapabilities(modelId),
    loadOpenRouterModelCapabilities: async (modelId: string) => {
      await mockLoadOpenRouterModelCapabilities(modelId);
    },
  });
}

async function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
) {
  // Most tests use fixed auth storage to keep assertions focused on model
  // resolution rather than auth discovery.
  const resolvedAgentDir = agentDir ?? state.agentDir();
  return await resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    runtimeHooks: createRuntimeHooks(),
  });
}

function mockDiscoveredGroqModel(maxTokensSource?: "configured" | "discovered") {
  mockDiscoveredModel(discoverModels, {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    templateModel: {
      provider: "groq",
      id: "llama-3.3-70b-versatile",
      name: "Llama 3.3 70B",
      api: "openai-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131_072,
      maxTokens: 32_768,
      ...(maxTokensSource ? { maxTokensSource } : {}),
    },
  });
}

function resolveModelAsyncForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    allowBundledStaticCatalogFallback?: boolean;
    preferBundledStaticCatalogTransport?: boolean;
    runtimeHooks?: ReturnType<typeof createRuntimeHooks>;
    skipAgentDiscovery?: boolean;
  },
) {
  const resolvedAgentDir = agentDir ?? state.agentDir();
  return resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    ...options,
    runtimeHooks: options?.runtimeHooks ?? createRuntimeHooks(),
  });
}

type ResolveModelForTestResult = Awaited<ReturnType<typeof resolveModelForTest>>;

function expectResolvedModel(result: ResolveModelForTestResult) {
  if (result.error !== undefined) {
    throw new Error(`expected model resolution to succeed, got error: ${result.error}`);
  }
  if (!result.model) {
    throw new Error("expected model resolution to return a model");
  }
  return result.model;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function mockModelDiscovery(
  overrides: {
    provider?: string;
    modelId?: string;
    templateModel?: unknown;
  } = {},
) {
  const provider = overrides.provider ?? "openai";
  const modelId = overrides.modelId ?? "gpt-5.5";
  mockDiscoveredModel(discoverModels, {
    provider,
    modelId,
    templateModel: overrides.templateModel ?? { provider, ...makeModel(modelId) },
  });
}

function mockOpenAIForwardCompatDiscovery(modelId = "gpt-5.4", overrides: Partial<Model> = {}) {
  const name =
    modelId === "gpt-5.3-codex-spark"
      ? "GPT-5.3 Codex Spark"
      : modelId === "gpt-5.4-mini"
        ? "GPT-5.4 Mini"
        : modelId === "gpt-5.5"
          ? "GPT-5.5"
          : "GPT-5.4";
  mockModelDiscovery({
    provider: "openai",
    modelId,
    templateModel: {
      ...buildOpenAICodexForwardCompatExpectation(modelId),
      name,
      ...overrides,
    },
  });
}

function mockMinimalModelDiscovery(
  provider: string,
  modelId: string,
  overrides: Record<string, unknown> = {},
) {
  mockModelDiscovery({
    provider,
    modelId,
    templateModel: { ...makeModel(modelId), provider, ...overrides },
  });
}

function makeProviderConfig(
  provider: string,
  overrides: Record<string, unknown> = {},
): OpenClawConfig {
  return makeOpenClawConfigFixture({
    models: {
      providers: {
        [provider]: { models: [], ...overrides },
      },
    },
  });
}

const deepSeekCatalogCompat = {
  supportsUsageInStreaming: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};

function makeDeepSeekCatalogModel(overrides: Partial<Model> = {}): Model {
  const { compat, ...modelOverrides } = overrides;
  return {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    ...modelOverrides,
    ...(compat ? { compat: { ...deepSeekCatalogCompat, ...compat } } : {}),
  };
}

function makeMistralCatalogModel(overrides: Partial<Model> = {}): Model {
  return {
    provider: "mistral",
    id: "mistral-medium-3-5",
    name: "Mistral Medium 3.5",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 8_192,
    ...overrides,
  };
}

function makeConfiguredDeepSeekModel(
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  const { compat, ...modelOverrides } = overrides;
  return {
    id: "deepseek-v4-pro",
    name: "Custom DeepSeek V4 Pro",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
    ...modelOverrides,
    ...(compat ? { compat: { ...compat } } : {}),
  };
}

function makeDeepSeekConfig(
  modelOverrides: Partial<ModelDefinitionConfig> = {},
  providerOverrides: Partial<ModelProviderConfig> = {},
): OpenClawConfig {
  return makeProviderConfig("deepseek", {
    models: [makeConfiguredDeepSeekModel(modelOverrides)],
    ...providerOverrides,
  });
}

function makeVllmQwenConfig(
  modelOverrides: Record<string, unknown> = {},
  providerOverrides: Record<string, unknown> = {},
): OpenClawConfig {
  return makeProviderConfig("vllm", {
    baseUrl: "http://localhost:9000",
    api: "openai-completions",
    models: [
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
        ...modelOverrides,
      },
    ],
    ...providerOverrides,
  });
}

describe("resolveModel", () => {
  it("consumes a directly prepared model through configured overrides and normalization", async () => {
    const preparedModel = {
      ...makeModel("prepared-model"),
      provider: "acme",
      name: "Prepared Model",
      api: "openai-completions" as const,
      baseUrl: "https://discovered.example/v1",
      input: ["text" as const],
      contextWindow: 65_536,
      maxTokens: 8_192,
    };
    const prepareProviderDynamicModel = vi.fn(async () => {
      auth.spy.mockImplementation(() => {
        throw new Error("Auth storage became unavailable after model preparation");
      });
      return preparedModel;
    });
    const runProviderDynamicModel = vi.fn(() => undefined);
    const normalizeProviderResolvedModelWithPlugin = vi.fn(
      ({ context }: { context: { model: Model } }) => ({
        ...context.model,
        name: "Normalized Prepared Model",
      }),
    );
    const cfg = makeProviderConfig("acme", {
      api: "openai-responses",
      baseUrl: "https://configured.example/v1",
      headers: { "X-Tenant": "tenant-a" },
    });

    const result = await resolveModelAsync("acme", "prepared-model", state.agentDir(), cfg, {
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        normalizeProviderResolvedModelWithPlugin,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "acme",
      id: "prepared-model",
      name: "Normalized Prepared Model",
      api: "openai-responses",
      baseUrl: "https://configured.example/v1",
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
    expect(expectResolvedModel(result).headers).toEqual(
      expect.objectContaining({ "X-Tenant": "tenant-a" }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalledOnce();
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
    expect(runProviderDynamicModel).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "keeps explicit configured models ahead of prepared models",
      preferRuntime: false,
      expectedName: "Configured Model",
      expectedPreparationCount: 0,
    },
    {
      description: "preserves manually configured limits during runtime comparison",
      preferRuntime: true,
      expectedName: "Prepared Model",
      expectedPreparationCount: 1,
    },
    {
      description: "replaces models-add metadata with a preferred prepared model",
      preferRuntime: true,
      metadataSource: "models-add" as const,
      expectedName: "Prepared Model",
      expectedPreparationCount: 1,
    },
  ])(
    "$description",
    async ({ preferRuntime, metadataSource, expectedName, expectedPreparationCount }) => {
      const prepareProviderDynamicModel = vi.fn(async () => ({
        ...makeModel("prepared-model"),
        provider: "acme",
        name: "Prepared Model",
        api: "openai-completions" as const,
        baseUrl: "https://discovered.example/v1",
        input: ["text" as const],
        contextWindow: 65_536,
        maxTokens: 8_192,
      }));
      const runProviderDynamicModel = vi.fn(() => undefined);
      const cfg = makeProviderConfig("acme", {
        api: "openai-responses",
        baseUrl: "https://configured.example/v1",
        models: [
          {
            ...makeModel("prepared-model"),
            name: "Configured Model",
            contextWindow: 32_768,
            maxTokens: 4_096,
            ...(metadataSource ? { metadataSource } : {}),
          },
        ],
      });
      if (!preferRuntime) {
        auth.spy.mockImplementation(() => {
          throw new Error("Explicit model resolution must not read auth storage");
        });
      }

      const result = await resolveModelAsync("acme", "prepared-model", state.agentDir(), cfg, {
        runtimeHooks: {
          ...createRuntimeHooks(),
          prepareProviderDynamicModel,
          runProviderDynamicModel,
          shouldPreferProviderRuntimeResolvedModel: () => preferRuntime,
        },
        skipAgentDiscovery: true,
      });

      expectRecordFields(expectResolvedModel(result), {
        name: expectedName,
        api: "openai-responses",
        baseUrl: "https://configured.example/v1",
        contextWindow: metadataSource ? 65_536 : 32_768,
      });
      expect(prepareProviderDynamicModel).toHaveBeenCalledTimes(expectedPreparationCount);
      expect(runProviderDynamicModel).not.toHaveBeenCalled();
    },
  );

  it("reuses agent discovery stores while the agent model files are unchanged", async () => {
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("looks up the lifecycle owner before applying a derived workspace", async () => {
    mockModelDiscovery();
    const cfg = {
      agents: { defaults: { workspace: state.path("config-derived-workspace") } },
    } as OpenClawConfig;

    const result = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), cfg, {
      agentId: "main",
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(result);
    expect(preparedSnapshotState.getInputs[0]).toEqual(
      expect.objectContaining({ agentId: "main", agentDir: state.agentDir() }),
    );
    expect(preparedSnapshotState.getInputs[0]).not.toHaveProperty("workspaceDir");
  });

  it("keeps prepared discovery generations separate for agents sharing directories", async () => {
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      agentId: "agent-a",
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      agentId: "agent-b",
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(discoverModels).toHaveBeenCalledTimes(2);
  });

  it("keeps lifecycle discovery stable when request route config changes", async () => {
    mockModelDiscovery();
    const providerConfig = (api: "openai-responses" | "openai-completions") =>
      ({
        models: {
          providers: {
            openai: {
              api,
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      }) as OpenClawConfig;

    const first = await resolveModelAsync(
      "openai",
      "gpt-5.5",
      state.agentDir(),
      providerConfig("openai-responses"),
      { runtimeHooks: createRuntimeHooks() },
    );
    const second = await resolveModelAsync(
      "openai",
      "gpt-5.5",
      state.agentDir(),
      providerConfig("openai-completions"),
      { runtimeHooks: createRuntimeHooks() },
    );

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("does not poll generated plugin catalogs between lifecycle generations", async () => {
    const agentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    mockDiscoveredModel(discoverModels, {
      provider: "zai",
      modelId: "glm-5.1",
      templateModel: {
        provider: "zai",
        ...makeModel("glm-5.1"),
      },
    });

    const first = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {},
        }),
      },
    });
    const second = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("reuses inherited auth from one lifecycle generation", async () => {
    const agentDir = state.agentDir("worker");
    const defaultAgentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        list: [
          { id: "main", default: true, agentDir: defaultAgentDir },
          { id: "worker", agentDir },
        ],
      },
    });
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
      },
      defaultAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("uses the resolved default agent workspace for prepared model discovery", async () => {
    const agentDir = state.agentDir("workspace-agent");
    const workspaceDir = state.workspaceDir;
    fs.mkdirSync(agentDir, { recursive: true });
    mockModelDiscovery();
    const cfg = makeOpenClawConfigFixture({
      agents: {
        list: [{ id: "workspace-agent", default: true, agentDir, workspace: workspaceDir }],
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(result);
    expect(discoverModels).toHaveBeenCalledWith(
      expect.anything(),
      agentDir,
      expect.objectContaining({ workspaceDir }),
    );
  });

  it("passes config into model discovery when auth storage is prebuilt", async () => {
    const agentDir = state.agentDir("configured");
    const workspaceDir = state.path("workspace-configured");
    const authStorage = { mocked: true } as never;
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    mockModelDiscovery();

    const options = {
      authStorage,
      workspaceDir,
      runtimeHooks: createRuntimeHooks(),
    };
    const result = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, options);

    expectResolvedModel(result);
    expect(discoverModels).toHaveBeenCalledWith(authStorage, agentDir, {
      config: cfg,
      workspaceDir,
    });
  });

  it("does not poll implicit main auth during request resolution", async () => {
    const agentDir = state.agentDir("worker");
    const mainAgentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(mainAgentDir, { recursive: true });
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
      },
      mainAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("keeps runtime auth snapshots inside the lifecycle generation", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            openai: { type: "api_key", key: "one" },
          },
        } as never,
      },
    ]);
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("keeps plugin auth overlays inside the lifecycle generation", async () => {
    resolveRuntimeSyntheticAuthProviderRefsMock.mockReturnValue(["runtime-provider"]);
    resolveRuntimeExternalAuthProviderRefsMock.mockReturnValue(["external-provider"]);
    mockModelDiscovery();

    const first = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("skips OpenClaw auth and model discovery during dynamic model resolution", async () => {
    const result = await resolveModelAsync(
      "openrouter",
      "openrouter/auto",
      state.agentDir(),
      undefined,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "openrouter",
      id: "openrouter/auto",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("resolves opt-in bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(makeMistralCatalogModel());

    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "mistral",
      id: "mistral-medium-3-5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 8192,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
    });
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("reuses configured static models from the loaded snapshot", async () => {
    const preparedModel = makeMistralCatalogModel();

    preparedSnapshotState.configuredRuntimeModels = [
      {
        provider: "mistral",
        modelId: "mistral-medium-3-5",
        model: preparedModel,
      },
    ];

    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "mistral",
      id: "mistral-medium-3-5",
      api: "openai-completions",
      contextWindow: 262144,
      maxTokens: 8192,
    });
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
  });

  it("resolves configured inline models from one prepared generation", async () => {
    const cfg = makeProviderConfig("deepseek", {
      api: "openai-completions",
      models: [{ id: "deepseek-v4-pro", name: "Configured DeepSeek" }],
    });
    const preparedModelRuntime = {
      catalogOwner: undefined,
      agentDir: state.agentDir(),
      activeProjectKeys: [],
      allowGatewaySubagentBinding: false,
      config: cfg,
      observationConfig: cfg,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: [
        {
          provider: "deepseek",
          modelId: "deepseek-v4-pro",
          model: makeDeepSeekCatalogModel(),
        },
      ],
      inlineProviderModels: buildInlineProviderModels(cfg.models?.providers ?? {}),
      createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
    } satisfies PreparedModelRuntimeSnapshot;

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: { find: vi.fn(() => null) } as never,
      preparedModelRuntime,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      name: "Configured DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
  });

  it("falls back when an opaque prepared handle has no model facts", async () => {
    const config = {};
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeMistralCatalogModel({ input: ["text"] }),
    );

    const preparedModelRuntime = {
      catalogOwner: undefined,
      agentDir: state.agentDir(),
      activeProjectKeys: [],
      allowGatewaySubagentBinding: false,
      config,
      observationConfig: config,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
    } satisfies PreparedModelRuntimeSnapshot;
    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: { mocked: true } as never,
        modelRegistry: { find: vi.fn(() => null) } as never,
        preparedModelRuntime,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "mistral",
      id: "mistral-medium-3-5",
      baseUrl: "https://api.mistral.ai/v1",
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledOnce();
  });

  it("resolves opt-in provider static catalog rows while skipping agent discovery", async () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const config = {};
    const preparedModelRuntime = {
      catalogOwner: undefined,
      agentDir: state.agentDir(),
      activeProjectKeys: [],
      allowGatewaySubagentBinding: false,
      config,
      observationConfig: config,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
    } satisfies PreparedModelRuntimeSnapshot;
    resolveBundledProviderStaticCatalogModelMock.mockResolvedValueOnce({
      provider: "google",
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });

    const result = await resolveModelAsync(
      "google",
      "gemini-3.1-pro-preview",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        preparedModelRuntime,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "google",
      id: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
      metadataSnapshot,
    });
    expect(resolveBundledProviderStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
      metadataSnapshot,
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("falls back to bundled static catalog rows without agent discovery", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    });
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn(() => undefined);

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", state.agentDir(), cfg, {
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.3-codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledTimes(1);
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.3-codex",
        cfg,
      }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("keeps a bundled static catalog window for a transport-only configured model", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    const cfg = makeProviderConfig("openai", {
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" }],
    });

    const result = await resolveModelForTest("openai", "gpt-5.3-codex", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.3-codex",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("resolves a deferred Fireworks manifest id from the bundled static catalog", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      name: "Kimi K2.6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0.95, output: 4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 262144,
    });

    const result = await resolveModelAsync(
      "fireworks",
      "accounts/fireworks/models/kimi-k2p6",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      contextWindow: 262144,
      maxTokens: 262144,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
      }),
    );
  });

  it("prefers user openclaw.json config over the Fireworks manifest for the same id", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      ...makeModel("accounts/fireworks/models/kimi-k2p6"),
      provider: "fireworks",
      name: "Kimi K2.6",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 262_144,
    });
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          fireworks: {
            api: "openai-completions",
            baseUrl: "https://api.fireworks.ai/inference/v1",
            models: [
              {
                ...makeModel("accounts/fireworks/models/kimi-k2p6"),
                name: "Kimi K2.6 (user override)",
                contextWindow: 300_000,
                maxTokens: 300_000,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest(
      "fireworks",
      "accounts/fireworks/models/kimi-k2p6",
      state.agentDir(),
      cfg,
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p6",
      contextWindow: 300_000,
      maxTokens: 300_000,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
        cfg,
      }),
    );
  });

  it("keeps provider dynamic metadata for runtime-preferred models", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123_456,
      maxTokens: 64_000,
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }));
    const shouldPreferProviderRuntimeResolvedModel = vi.fn(() => true);

    const result = await resolveModelAsync("openai", "gpt-5.5-pro", state.agentDir(), undefined, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        shouldPreferProviderRuntimeResolvedModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-chatgpt-responses",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(prepareProviderDynamicModel).toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalled();
    expect(shouldPreferProviderRuntimeResolvedModel).toHaveBeenCalled();
  });

  it.each([undefined, "openai:prepared"])(
    "keeps the prepared auth mode through async provider model resolution (profile %s)",
    async (authProfileId) => {
      auth.spy.mockImplementation(() => {
        throw new Error("Prepared auth mode must not read auth storage");
      });
      const baseRuntimeHooks = createRuntimeHooks();
      const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
      const runProviderDynamicModel = vi.fn(
        (params: { context: { authProfileMode?: string } }) => ({
          provider: "openai",
          ...makeModel("gpt-5.5"),
          api:
            params.context.authProfileMode === "api_key"
              ? ("openai-responses" as const)
              : ("openai-chatgpt-responses" as const),
          baseUrl:
            params.context.authProfileMode === "api_key"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api",
        }),
      );

      const result = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
        authProfileId,
        authProfileMode: "api_key",
        runtimeHooks: {
          ...baseRuntimeHooks,
          prepareProviderDynamicModel,
          runProviderDynamicModel,
        },
        skipAgentDiscovery: true,
      });

      expectRecordFields(expectResolvedModel(result), {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expectRecordFields(mockCallArg(prepareProviderDynamicModel).context, {
        ...(authProfileId ? { authProfileId } : {}),
        authProfileMode: "api_key",
      });
      expectRecordFields(mockCallArg(runProviderDynamicModel).context, {
        ...(authProfileId ? { authProfileId } : {}),
        authProfileMode: "api_key",
      });
    },
  );

  it("looks up each static fallback candidate with its own normalized model id", async () => {
    resolveBundledStaticCatalogModelMock.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));

    const anthropicResult = await resolveModelAsync(
      "anthropic",
      "anthropic/claude-haiku-4-5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
      },
    );
    const openaiResult = await resolveModelAsync("openai", "gpt-4o", state.agentDir(), undefined, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
    });

    expectRecordFields(expectResolvedModel(anthropicResult), {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    expectRecordFields(expectResolvedModel(openaiResult), {
      provider: "openai",
      id: "gpt-4o",
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-4o",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
    });
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "claude-haiku-4-5",
      }),
    );
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "anthropic/claude-haiku-4-5",
      }),
    );
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("applies provider overrides to bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "mistral",
      id: "mistral-medium-3-5",
      name: "Mistral Medium 3.5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
    });
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          mistral: {
            baseUrl: "https://mistral-proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy": "static-fast-path" },
            request: { proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" } },
            localService: {
              command: "/opt/mistral/start",
              args: ["--port", "18080"],
              healthUrl: "http://127.0.0.1:18080/health",
            },
            models: [],
          },
        },
      },
    });

    const result = await resolveModelAsync("mistral", "mistral-medium-3-5", state.agentDir(), cfg, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("https://mistral-proxy.example.com/v1");
    expect(model.headers).toEqual({ "X-Proxy": "static-fast-path" });
    expect(getModelProviderRequestTransport(model)).toEqual({
      proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" },
    });
    expect(getModelProviderLocalService(model)).toEqual({
      command: "/opt/mistral/start",
      args: ["--port", "18080"],
      healthUrl: "http://127.0.0.1:18080/health",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("merges bundled static media input into resolved models when opted in", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5-pro",
      templateModel: {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
    });
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.5-pro", state.agentDir(), undefined, {
      allowBundledStaticCatalogFallback: true,
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect((expectResolvedModel(result) as { mediaInput?: unknown }).mediaInput).toEqual({
      image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
    });
  });

  it("merges configured media input with discovered model metadata", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "vision-model",
      templateModel: {
        id: "vision-model",
        name: "Vision Model",
        provider: "custom",
        api: "openai-responses",
        baseUrl: "https://models.example.com/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        mediaInput: {
          image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
        },
      },
    });

    const result = await resolveModelForTest("custom", "vision-model", state.agentDir(), {
      models: {
        providers: {
          custom: {
            baseUrl: "https://models.example.com/v1",
            models: [
              {
                id: "vision-model",
                name: "Vision Model",
                mediaInput: { image: { maxBytes: 1 } },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect((expectResolvedModel(result) as { mediaInput?: unknown }).mediaInput).toEqual({
      image: { maxBytes: 1, maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
    });
  });

  it("does not read manifest or provider static rows when bundled fallback is disabled", async () => {
    const result = await resolveModelAsync(
      "mistral",
      "mistral-medium-3-5",
      state.agentDir(),
      undefined,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: mistral/mistral-medium-3-5");
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("defaults model input to text when discovery omits input", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "missing-input",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const result = await resolveModelForTest("custom", "missing-input", state.agentDir(), {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9999",
            api: "openai-completions",
            // Intentionally keep this minimal — the discovered model provides the rest.
            models: [{ id: "missing-input", name: "missing-input" }],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(expectResolvedModel(result).input).toEqual(["text"]);
  });

  it("defaults missing model cost before handing models to OpenClaw", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    };

    const result = await resolveModelForTest("openai", "gpt-5.5", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.5",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("includes provider baseUrl in fallback model", async () => {
    const cfg = makeProviderConfig("custom", { baseUrl: "http://localhost:9000" });

    const result = await resolveModelForTest("custom", "missing-model", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("http://localhost:9000");
    expect(model.provider).toBe("custom");
    expect(model.id).toBe("missing-model");
    expect(model.api).toBe("openai-completions");
  });

  it("defaults baseUrl-only Google fallback models to native Gemini transport", async () => {
    const cfg = makeProviderConfig("google", {
      baseUrl: "https://generativelanguage.googleapis.com",
    });

    const result = await resolveModelForTest(
      "google",
      "gemini-2.5-flash-lite",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expect(model.provider).toBe("google");
    expect(model.id).toBe("gemini-2.5-flash-lite");
    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("defaults baseUrl-only Google Vertex fallback models to native Vertex transport", async () => {
    const cfg = makeProviderConfig("google-vertex", {
      baseUrl: "https://aiplatform.googleapis.com",
    });

    const result = await resolveModelForTest(
      "google-vertex",
      "gemini-2.5-flash",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expect(model.provider).toBe("google-vertex");
    expect(model.id).toBe("gemini-2.5-flash");
    expect(model.api).toBe("google-vertex");
    expect(model.baseUrl).toBe("https://aiplatform.googleapis.com");
  });

  it("clamps per-model maxTokens to the per-model context window", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "xiaomi-token-plan",
      id: "mimo-v2.5-pro",
      name: "Xiaomi MiMo V2.5 Pro",
      api: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    });
    const cfg = makeProviderConfig("xiaomi-token-plan", {
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      api: "openai-completions",
      models: [
        {
          id: "mimo-v2.5-pro",
          name: "Xiaomi MiMo V2.5 Pro",
          contextWindow: 16_000,
          maxTokens: 32_000,
        },
      ],
    });

    const result = await resolveModelForTest(
      "xiaomi-token-plan",
      "mimo-v2.5-pro",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expect(model.name).toBe("Xiaomi MiMo V2.5 Pro");
    expect(model.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
    expect(model.contextWindow).toBe(16_000);
    expect(model.maxTokens).toBe(16_000);
    expectRecordFields(model, { maxTokensSource: "configured" });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "xiaomi-token-plan",
      modelId: "mimo-v2.5-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("preserves configured maxTokens provenance from model discovery", async () => {
    mockDiscoveredGroqModel("configured");

    const result = await resolveModelForTest("groq", "llama-3.3-70b-versatile", state.agentDir());
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      maxTokens: 32_768,
      maxTokensSource: "configured",
    });
  });

  it("marks a provider-level maxTokens override as configured", async () => {
    mockDiscoveredGroqModel();
    const cfg = makeProviderConfig("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
      api: "openai-completions",
      maxTokens: 2_048,
    });

    const result = await resolveModelForTest(
      "groq",
      "llama-3.3-70b-versatile",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      maxTokens: 2_048,
      maxTokensSource: "configured",
    });
  });

  it("marks a configured-model top-level maxTokens override as configured", async () => {
    mockDiscoveredGroqModel();
    const cfg = makeProviderConfig("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
      api: "openai-completions",
      models: [
        {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B",
          maxTokens: 4_096,
        },
      ],
    });

    const result = await resolveModelForTest(
      "groq",
      "llama-3.3-70b-versatile",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      maxTokens: 4_096,
      maxTokensSource: "configured",
    });
  });

  it("leaves maxTokens undefined when no configured or catalog value is available (regression: #98295)", async () => {
    // Regression for https://github.com/openclaw/openclaw/issues/98295.
    // A custom provider entry without maxTokens (and no matching bundled
    // static catalog row) must not synthesize an oversized output cap from
    // DEFAULT_CONTEXT_TOKENS. Leaving maxTokens undefined lets the transport
    // omit `max_completion_tokens` so the provider applies its own default,
    // avoiding HTTP 400 (Param Incorrect) from strict OpenAI-compatible
    // servers whose completion-token ceiling is below the synthesized value.
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(undefined);
    const cfg = makeProviderConfig("xiaomi", {
      baseUrl: "https://api.xiaomimimo.com/v1",
      models: [{ id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" }],
    });

    const result = await resolveModelForTest("xiaomi", "mimo-v2.5-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(model.id).toBe("mimo-v2.5-pro");
    expect(model.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(model.maxTokens).toBeUndefined();
  });

  it("inherits bundled static transport for configured provider fallback models", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ compat: deepSeekCatalogCompat }),
    );
    const cfg = makeDeepSeekConfig({ compat: { supportsReasoningEffort: false } }, { baseUrl: "" });

    const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      name: "Custom DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("fills missing configured provider runtime transport from bundled static metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ compat: deepSeekCatalogCompat }),
    );
    const cfg = makeDeepSeekConfig({ thinkingLevelMap: { off: null } });
    const baseRuntimeHooks = createRuntimeHooks();
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "deepseek",
      ...makeConfiguredDeepSeekModel(),
    }));

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      runtimeHooks: {
        ...baseRuntimeHooks,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect(runProviderDynamicModel).toHaveBeenCalled();
  });

  it("resolves configured DeepSeek probe models through bundled static transport without agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ compat: deepSeekCatalogCompat }),
    );
    const cfg = makeDeepSeekConfig({ thinkingLevelMap: { off: null } });

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      name: "Custom DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect((model as { thinkingLevelMap?: unknown }).thinkingLevelMap).toEqual({ off: null });
  });

  it("keeps provider runtime transport ahead of bundled static fallback metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(makeDeepSeekCatalogModel());
    const cfg = makeDeepSeekConfig();
    const baseRuntimeHooks = createRuntimeHooks();
    const runProviderDynamicModel = vi.fn(() =>
      makeDeepSeekCatalogModel({
        name: "Runtime DeepSeek V4 Pro",
        api: "openai-responses",
        baseUrl: "https://runtime.deepseek.example/v1",
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 4_096,
      }),
    );

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      runtimeHooks: {
        ...baseRuntimeHooks,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-responses",
      baseUrl: "https://runtime.deepseek.example/v1",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(runProviderDynamicModel).toHaveBeenCalled();
  });

  it("keeps configured transport overrides ahead of bundled static fallback metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(makeDeepSeekCatalogModel());
    const cfg = makeDeepSeekConfig(
      {
        baseUrl: "https://deepseek-model-proxy.example.com/v1",
        api: "openai-responses",
      },
      {
        baseUrl: "https://deepseek-proxy.example.com/v1",
        api: "openai-completions",
      },
    );

    const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-responses",
      baseUrl: "https://deepseek-model-proxy.example.com/v1",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
  });

  it("keeps bundled static baseUrl when provider api is configured without a baseUrl", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ api: "openai-responses" }),
    );
    const cfg = makeDeepSeekConfig(
      { thinkingLevelMap: { off: null } },
      { api: "openai-completions" },
    );

    const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.thinkingLevelMap).toEqual({ off: null });
  });

  it("keeps per-model token overrides ahead of bundled static fallback metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "xiaomi-token-plan",
      id: "mimo-v2.5-pro",
      name: "Xiaomi MiMo V2.5 Pro",
      api: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 1_048_576,
      contextTokens: 500_000,
      maxTokens: 32_000,
    });
    const cfg = makeProviderConfig("xiaomi-token-plan", {
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      api: "openai-completions",
      maxTokens: 512,
      models: [
        {
          id: "mimo-v2.5-pro",
          name: "Xiaomi MiMo V2.5 Pro",
          contextWindow: 100_000,
          contextTokens: 90_000,
        },
      ],
    });

    const result = await resolveModelForTest(
      "xiaomi-token-plan",
      "mimo-v2.5-pro",
      state.agentDir(),
      cfg,
    );
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      contextWindow: 100_000,
      contextTokens: 90_000,
      maxTokens: 512,
    });
  });

  it("does not synthesize unknown models from timeout-only provider overlays", async () => {
    const cfg = makeProviderConfig("openai", { timeoutSeconds: 300, baseUrl: "" });

    const result = await resolveModelForTest("openai", "typo-model", state.agentDir(), cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai/typo-model");
  });

  it("does not create fallback models from provider overlays alone", async () => {
    const cfg = {
      models: {
        providers: {
          typoProvider: {
            timeoutSeconds: 600,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest(
      "typoProvider",
      "typoed-model",
      state.agentDir(),
      makeOpenClawConfigFixture(cfg),
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: typoProvider/typoed-model");
  });

  it("does not create fallback models from built-in provider api overlays", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest(
      "openai",
      "typoed-model",
      state.agentDir(),
      makeOpenClawConfigFixture(cfg),
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai/typoed-model");
  });

  it("resolves per-model api and baseUrl override in fallback model", async () => {
    const cfg = {
      models: {
        providers: {
          "my-router": {
            baseUrl: "http://localhost:8080",
            api: "ollama",
            models: [
              {
                id: "my-router/claude",
                name: "Claude via Router",
                api: "anthropic-messages",
                input: ["text", "image"],
                contextWindow: 200_000,
              },
              {
                id: "my-router/gpt",
                name: "GPT via Router",
                api: "openai-completions",
                baseUrl: "http://localhost:8080/v1",
                input: ["text"],
                contextWindow: 400_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const claude = await resolveModelForTest(
      "my-router",
      "my-router/claude",
      state.agentDir(),
      cfg,
    );
    const claudeModel = expectResolvedModel(claude);
    expect(claudeModel.api).toBe("anthropic-messages");
    expect(claudeModel.baseUrl).toBe("http://localhost:8080");
    expect(claudeModel.maxTokens).toBeUndefined();

    const gpt = await resolveModelForTest("my-router", "my-router/gpt", state.agentDir(), cfg);
    const gptModel = expectResolvedModel(gpt);
    expect(gptModel.api).toBe("openai-completions");
    expect(gptModel.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("preserves normalized inline provider transport when static metadata is merged", async () => {
    const cfg = makeProviderConfig("my-gemini", {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [
        {
          id: "gemini-pro",
          name: "Gemini Pro",
          input: ["text"],
          contextWindow: 32_768,
        },
      ],
    });

    const result = await resolveModelForTest("my-gemini", "gemini-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("defaults baseUrl-only local custom fallback models to chat completions", async () => {
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          model: { primary: "local-agent-proxy/gpt-5.2" },
        },
      },
      models: {
        providers: {
          "local-agent-proxy": {
            baseUrl: "http://127.0.0.1:3000/v1",
            models: [],
          },
        },
      },
    });

    const result = await resolveModelForTest("local-agent-proxy", "gpt-5.2", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      provider: "local-agent-proxy",
      id: "gpt-5.2",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
    });
    expect(getModelProviderRequestTransport(model)).toBeUndefined();
  });

  it("attaches provider localService metadata to configured fallback models", async () => {
    const cfg = makeProviderConfig("ds4", {
      baseUrl: "http://127.0.0.1:18000/v1",
      api: "openai-completions",
      localService: {
        command: "/opt/ds4/ds4-server",
        args: ["--port", "18000"],
        healthUrl: "http://127.0.0.1:18000/v1/models",
        readyTimeoutMs: 180_000,
        idleStopMs: 0,
      },
    });

    const result = await resolveModelForTest("ds4", "deepseek-v4-flash", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(getModelProviderLocalService(model)).toEqual({
      command: "/opt/ds4/ds4-server",
      args: ["--port", "18000"],
      healthUrl: "http://127.0.0.1:18000/v1/models",
      readyTimeoutMs: 180_000,
      idleStopMs: 0,
    });
  });

  it("resolves explicitly configured qwen3.6-plus before Coding Plan built-in suppression", async () => {
    const cfg = {
      models: {
        providers: {
          qwen: {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.6-plus",
                name: "qwen3.6-plus",
                input: ["text", "image"],
                reasoning: false,
                contextWindow: 1_000_000,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelForTest("qwen", "qwen3.6-plus", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "qwen",
      id: "qwen3.6-plus",
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
  });

  it("keeps unconfigured qwen3.6-plus suppressed on Coding Plan endpoints", async () => {
    const cfg = makeProviderConfig("qwen", {
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      api: "openai-completions",
    });

    const result = await resolveModelForTest("qwen", "qwen3.6-plus", state.agentDir(), cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.",
    );
  });

  it("#74451: resolves explicitly configured openai/gpt-5.4-mini inline entries", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            models: [
              {
                id: "gpt-5.4-mini",
                name: "GPT-5.4 mini",
                api: "openai-chatgpt-responses",
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelForTest("openai", "gpt-5.4-mini", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-chatgpt-responses",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes Google fallback baseUrls for custom providers", async () => {
    const cfg = makeProviderConfig("google-paid", {
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai",
    });

    const result = await resolveModelForTest("google-paid", "missing-model", state.agentDir(), cfg);

    expect(expectResolvedModel(result).baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("normalizes configured Google override baseUrls when provider api is omitted", async () => {
    mockMinimalModelDiscovery("google", "gemini-2.5-pro", {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });

    const cfg = makeProviderConfig("google", {
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }],
    });

    const result = await resolveModelForTest("google", "gemini-2.5-pro", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes custom api.openai.com providers to responses transport", async () => {
    const cfg = makeProviderConfig("custom-openai", {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [{ ...makeModel("gpt-5.4"), provider: "custom-openai" }],
    });

    const result = await resolveModelForTest("custom-openai", "gpt-5.4", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("normalizes custom api.x.ai providers to responses transport", async () => {
    const cfg = makeProviderConfig("custom-xai", {
      baseUrl: "https://api.x.ai/v1",
      api: "openai-completions",
      models: [{ ...makeModel("grok-4.1-fast"), provider: "custom-xai" }],
    });

    const result = await resolveModelForTest("custom-xai", "grok-4.1-fast", state.agentDir(), cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "custom-xai",
      id: "grok-4.1-fast",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("leaves dynamic GitHub Copilot request identity to runtime auth preparation", async () => {
    const result = await resolveModelForTest("github-copilot", "gpt-5.5", state.agentDir());
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toBeUndefined();
  });

  it("leaves configured GitHub Copilot request identity to runtime auth preparation", async () => {
    const cfg = makeProviderConfig("github-copilot", {
      baseUrl: "https://api.githubcopilot.com",
      api: "openai-responses",
      models: [makeModel("gpt-5.5")],
    });

    const result = await resolveModelForTest("github-copilot", "gpt-5.5", state.agentDir(), cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toBeUndefined();
  });

  it("includes provider headers in provider fallback model", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      headers: { "X-Custom-Auth": "token-123" },
      models: [makeModel("listed-model")],
    });

    // Requesting a non-listed model forces the providerCfg fallback branch.
    const result = await resolveModelForTest("custom", "missing-model", state.agentDir(), cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops SecretRef marker provider headers in fallback models", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
        "X-Managed": "secretref-managed",
        "X-Custom-Auth": "token-123",
      },
      models: [makeModel("listed-model")],
    });

    const result = await resolveModelForTest("custom", "missing-model", state.agentDir(), cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", async () => {
    mockMinimalModelDiscovery("custom", "listed-model", {
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
        "X-Managed": "secretref-managed",
        "X-Static": "tenant-a",
      },
    });

    const result = await resolveModelForTest("custom", "listed-model", state.agentDir());
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("prefers matching configured model metadata for fallback token limits", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      models: [
        { ...makeModel("model-a"), contextWindow: 4096, maxTokens: 1024 },
        { ...makeModel("model-b"), contextWindow: 262144, maxTokens: 32768 },
      ],
    });

    const result = await resolveModelForTest("custom", "model-b", state.agentDir(), cfg);
    const model = expectResolvedModel(result);

    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(32768);
  });

  it("merges configured model params with agent defaults for resolved models", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3:32b", {
      params: { num_ctx: 4096, keep_alive: "1m" },
    });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "OLLAMA/qwen3:32B": {
              params: { num_ctx: 8192, thinking: "low" },
            },
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [
              {
                ...makeModel("qwen3:32b"),
                params: { num_ctx: 16384 },
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("ollama", "qwen3:32b", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 16384,
      keep_alive: "1m",
      thinking: "low",
    });
  });

  it("applies configured provider params to resolved models", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3:32b", { params: { keep_alive: "1m" } });
    const cfg = makeProviderConfig("ollama", {
      baseUrl: "http://localhost:11434",
      params: { num_ctx: 65536, top_p: 0.9 },
    });

    const result = await resolveModelForTest("ollama", "qwen3:32b", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      keep_alive: "1m",
      num_ctx: 65536,
      top_p: 0.9,
    });
  });

  it("resolves provider request timeout metadata for configured provider models", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3:32b");
    const cfg = makeProviderConfig("ollama", {
      baseUrl: "http://localhost:11434",
      timeoutSeconds: 300,
      models: [makeModel("qwen3:32b")],
    });

    const result = await resolveModelForTest("ollama", "qwen3:32b", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      300_000,
    );
  });

  it("resolves provider request timeout metadata from built-in provider overlays", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.5");
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: 600,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest(
      "openai",
      "gpt-5.5",
      state.agentDir(),
      makeOpenClawConfigFixture(cfg),
    );

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      600_000,
    );
  });

  it("caps oversized provider request timeout metadata at the timer-safe ceiling", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.5");
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest(
      "openai",
      "gpt-5.5",
      state.agentDir(),
      makeOpenClawConfigFixture(cfg),
    );

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("uses per-model context config over discovered metadata", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3.5:9b", {
      contextWindow: 216_000,
      contextTokens: 216_000,
      maxTokens: 65_536,
    });
    const cfg = makeProviderConfig("ollama", {
      baseUrl: "http://localhost:11434",
      models: [
        { id: "qwen3.5:9b", name: "qwen3.5:9b", contextWindow: 8_192, contextTokens: 8_000 },
      ],
    });

    const result = await resolveModelForTest("ollama", "qwen3.5:9b", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(8_192);
    expect((result.model as { contextTokens?: number } | undefined)?.contextTokens).toBe(8_000);
    expect(result.model?.maxTokens).toBe(8_192);
  });

  it("keeps per-model context values with a provider output-token default", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3.5:9b", {
      contextWindow: 216_000,
      maxTokens: 65_536,
    });
    const cfg = makeProviderConfig("ollama", {
      baseUrl: "http://localhost:11434",
      maxTokens: 4_096,
      models: [
        {
          id: "qwen3.5:9b",
          name: "qwen3.5:9b",
          contextWindow: 16_384,
          maxTokens: 12_000,
        },
      ],
    });

    const result = await resolveModelForTest("ollama", "qwen3.5:9b", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(16_384);
    expect(result.model?.maxTokens).toBe(12_000);
  });

  it("applies agent default model params without explicit provider config", async () => {
    mockMinimalModelDiscovery("ollama", "llama3.2");
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "ollama/llama3.2": {
              params: { num_ctx: 32768 },
            },
          },
        },
      },
    });

    const result = await resolveModelForTest("ollama", "llama3.2", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 32768,
    });
  });

  it("propagates reasoning from matching configured fallback model", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      models: [
        { ...makeModel("model-a"), reasoning: false },
        { ...makeModel("model-b"), reasoning: true },
      ],
    });

    const result = await resolveModelForTest("custom", "model-b", state.agentDir(), cfg);

    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates compat from matching configured fallback model", async () => {
    const cfg = makeProviderConfig("vllm", {
      baseUrl: "http://localhost:9000",
      api: "openai-completions",
      models: [
        {
          ...makeModel("Qwen/Qwen3-8B"),
          compat: { thinkingFormat: "qwen-chat-template" },
        },
      ],
    });

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.compat).toEqual(
      expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
    );
    expect(result.model?.reasoning).toBe(false);
  });

  it("lets configured vLLM Qwen compat override stale discovered reasoning", async () => {
    mockMinimalModelDiscovery("vllm", "Qwen/Qwen3-8B", {
      api: "openai-completions",
      baseUrl: "http://localhost:9000",
      reasoning: false,
      compat: { supportsStrictMode: false },
    });
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
    expect(result.model?.compat).toEqual(
      expect.objectContaining({
        supportsStrictMode: false,
        thinkingFormat: "qwen-chat-template",
      }),
    );
  });

  it("does not derive reasoning from ignored compat on a catalog-owned vLLM route", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      ...makeModel("Qwen/Qwen3-8B"),
      provider: "vllm",
      api: "openai-completions",
      baseUrl: "http://localhost:9000",
      reasoning: false,
      compat: { supportsStrictMode: false },
    });
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(false);
    expect(result.model?.compat).toEqual(expect.objectContaining({ supportsStrictMode: false }));
    expect(result.model?.compat).not.toHaveProperty("thinkingFormat");
  });

  it("infers reasoning for matching vLLM Qwen compat fallback models", async () => {
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates image input capability from matching configured fallback model", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      models: [
        { ...makeModel("model-a"), input: ["text"] },
        { ...makeModel("model-b"), input: ["text", "image"] },
      ],
    });

    const result = await resolveModelForTest("custom", "model-b", state.agentDir(), cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("propagates image input when configured model ids include the provider prefix", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      api: "openai-completions",
      models: [{ ...makeModel("custom/vision-model"), input: ["text", "image"] }],
    });

    const result = await resolveModelForTest("custom", "vision-model", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("does not match provider-prefixed configured model ids through core provider aliases", async () => {
    const cfg = makeProviderConfig("volcengine", {
      baseUrl: "http://localhost:9000",
      api: "openai-completions",
      models: [{ ...makeModel("volcengine/vision-model"), input: ["text", "image"] }],
    });

    const result = await resolveModelForTest("bytedance", "vision-model", state.agentDir(), cfg);

    expect(result.error).toBe("Unknown model: bytedance/vision-model");
  });

  it("resolves direct moonshotai refs through manifest-owned provider aliases", async () => {
    const cfg = makeProviderConfig("moonshot", {
      baseUrl: "https://api.moonshot.ai/v1",
      api: "openai-completions",
      models: [{ ...makeModel("kimi-k2.6"), name: "Kimi K2.6", input: ["text", "image"] }],
    });

    const result = await resolveModelForTest("moonshotai", "kimi-k2.6", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "moonshot",
      id: "kimi-k2.6",
    });
  });

  it("resolves direct moonshot-ai refs through manifest-owned provider aliases", async () => {
    const cfg = makeProviderConfig("moonshot", {
      baseUrl: "https://api.moonshot.ai/v1",
      api: "openai-completions",
      models: [makeModel("kimi-k2.6")],
    });

    const result = await resolveModelForTest("moonshot-ai", "kimi-k2.6", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "moonshot",
      id: "kimi-k2.6",
    });
  });

  it("keeps transport-overriding manifest aliases on the requested provider", async () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "azure-openai-responses",
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.5",
      state.agentDir(),
      cfg,
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("infers provider-level Azure transport aliases from the configured endpoint", async () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            models: [],
          },
        },
      },
    };
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      state.agentDir(),
      cfg,
      {
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("uses manifest alias base URLs before discovered target endpoints", async () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "",
            models: [],
            params: { temperature: 0.2 },
          },
        },
      },
    };
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: {
        api: "azure-openai-responses",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      state.agentDir(),
      cfg,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://manifest-alias.example.com/openai/v1",
    });
  });

  it("keeps retained manifest alias ownership without provider config", async () => {
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: {
        api: "azure-openai-responses",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://manifest-alias.example.com/openai/v1",
    });
  });

  it("resolves manifest alias metadata once per async model lookup", async () => {
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      transport: { api: "azure-openai-responses" },
    });
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel: vi.fn(({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? {
              provider: "openai",
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            }
          : undefined,
      ),
    };

    const result = await resolveModelAsyncForTest(
      "azure-openai-responses",
      "gpt-5.5",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(resolveManifestModelCatalogProviderAliasMetadataMock).toHaveBeenCalledTimes(1);
  });

  it.each(["sync", "async"] as const)(
    "rejects configured fallbacks for ambiguous manifest aliases in the $resolver resolver",
    async (resolver) => {
      resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
        provider: "azure-openai-responses",
        ambiguous: true,
      });
      const cfg = {
        models: {
          providers: {
            "azure-openai-responses": {
              baseUrl: "https://example.openai.azure.com/openai/v1",
              api: "azure-openai-responses" as const,
              models: [makeModel("gpt-5.5")],
            },
          },
        },
      };

      const result =
        resolver === "sync"
          ? await resolveModelForTest("azure-openai-responses", "gpt-5.5", state.agentDir(), cfg)
          : await resolveModelAsyncForTest(
              "azure-openai-responses",
              "gpt-5.5",
              state.agentDir(),
              cfg,
            );

      expect(result.model).toBeUndefined();
      expect(result.error).toBe("Unknown model: azure-openai-responses/gpt-5.5");
      expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
      expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
    },
  );

  it("does not treat arbitrary namespaced model ids as provider prefixes", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("meta/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("custom", "vision-model", state.agentDir(), cfg);

    expect(result.model?.id).toBe("vision-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("resolves custom MLX-style Hugging Face ids without adding the provider prefix", async () => {
    const modelId = "mlx-community/Qwen3-30B-A3B-6bit";
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          model: { primary: `mlx/${modelId}` },
        },
      },
      models: {
        providers: {
          mlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            apiKey: "mlx-local",
            api: "openai-completions",
            models: [
              {
                ...makeModel(modelId),
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("mlx", modelId, state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "mlx",
      id: modelId,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  it("prefers provider-prefixed configured metadata over discovered text-only models", async () => {
    mockMinimalModelDiscovery("custom", "vision-model", { input: ["text"] });
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("custom/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("custom", "vision-model", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("keeps unknown fallback models text-only instead of borrowing image input from another configured model", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("custom", "typoed-model", state.agentDir(), cfg);

    expect(result.model?.id).toBe("typoed-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("explains when an agent model entry is missing provider model registration", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "microsoft-foundry/Kimi-K2.6-1": {
              contextWindow: 262144,
              maxOutputTokens: 16384,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync(
      "microsoft-foundry",
      "Kimi-K2.6-1",
      state.agentDir(),
      cfg,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBe(
      'Unknown model: microsoft-foundry/Kimi-K2.6-1. Found agents.defaults.models["microsoft-foundry/Kimi-K2.6-1"], but no matching models.providers["microsoft-foundry"].models[] entry. Add { "id": "Kimi-K2.6-1", "name": "Kimi-K2.6-1" } to models.providers["microsoft-foundry"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it.each([
    {
      name: "agent model entry",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {},
            },
          },
        },
      },
    },
    {
      name: "legacy provider config",
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" }],
            },
          },
        },
      },
    },
  ])("suggests running doctor for openai-codex from $name", async ({ cfg }) => {
    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      state.agentDir(),
      cfg as unknown as OpenClawConfig,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBe(
      'Unknown model: openai-codex/gpt-5.4. "openai-codex" is a legacy provider ID. Run `openclaw doctor --fix` to migrate legacy model and provider config to the current OpenAI format. If the provider has no authenticated profile, run `openclaw models status` to check provider auth and re-authenticate if needed. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("suggests adding config entry when a non-bundled provider model is missing", async () => {
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "custom-provider/some-model": {},
          },
        },
      },
    });

    const result = await resolveModelAsync("custom-provider", "some-model", state.agentDir(), cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: custom-provider/some-model. Found agents.defaults.models["custom-provider/some-model"], but no matching models.providers["custom-provider"].models[] entry. Add { "id": "some-model", "name": "some-model" } to models.providers["custom-provider"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("points runtime-bound model entries at the runtime catalog instead of provider registration", async () => {
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.3-codex": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", state.agentDir(), cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: openai/gpt-5.3-codex. Found agents.defaults.models["openai/gpt-5.3-codex"] bound to the "codex" agent runtime. Models served by an agent runtime come from that runtime and its linked account, not from models.providers["openai"].models[] — registering it there will not make it usable. Confirm "gpt-5.3-codex" is still offered by the "codex" runtime and switch agents.defaults.model.primary to a currently available model (run `openclaw models list --provider openai` to list them). See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("repairs stale text-only Foundry fallback rows for GPT-family models", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("microsoft-foundry", "gpt-5.4", state.agentDir(), cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Anthropic fallback rows for Claude vision models", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            models: [
              {
                ...makeModel("claude-sonnet-4-5"),
                name: "claude-sonnet-4-5",
                api: "anthropic-messages",
                input: ["text"],
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest(
      "anthropic",
      "claude-sonnet-4-5",
      state.agentDir(),
      cfg,
    );

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows for GPT-family models", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    });

    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = await resolveModelForTest("microsoft-foundry", "gpt-5.4", state.agentDir(), cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = await resolveModelForTest("microsoft-foundry", "gpt-5.4", state.agentDir());

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("matches prefixed OpenRouter native ids in configured fallback models", () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("openrouter/healer-alpha"),
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    });

    const models = buildInlineProviderModels(cfg.models?.providers ?? {});
    const model = models.find((entry) => entry.id === "openrouter/healer-alpha");
    expectRecordFields(model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("uses OpenRouter API capabilities for unknown models when cache is populated", async () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue({
      name: "Healer Alpha",
      input: ["text", "image"],
      reasoning: true,
      supportsTools: false,
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    const result = await resolveModelForTest(
      "openrouter",
      "openrouter/healer-alpha",
      state.agentDir(),
    );

    expect(result.error).toBeUndefined();
    const resolvedModel = expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      name: "Healer Alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
    expect((resolvedModel.compat as { supportsTools?: boolean } | undefined)?.supportsTools).toBe(
      false,
    );
  });

  it("falls back to text-only when OpenRouter API cache is empty", async () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);

    const result = await resolveModelForTest(
      "openrouter",
      "openrouter/healer-alpha",
      state.agentDir(),
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: false,
      input: ["text"],
    });
  });

  it("uses provider-normalized model ids for OpenRouter transport", async () => {
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId,
      templateModel: {
        ...makeModel(modelId),
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const normalizeProviderResolvedModelWithPlugin = vi.fn(
      (params: { context: { model: { id: string } } }) => ({
        ...params.context.model,
        id: params.context.model.id.slice("openrouter/".length),
      }),
    );

    const result = await resolveModelAsync("openrouter", modelId, state.agentDir(), undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: {
        ...baseRuntimeHooks,
        normalizeProviderResolvedModelWithPlugin,
      },
    });

    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        context: expect.objectContaining({
          modelId,
          model: expect.objectContaining({ id: modelId }),
        }),
      }),
    );
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("matches prefixed Hugging Face ids against discovered registry models", async () => {
    mockMinimalModelDiscovery("huggingface", "deepseek-ai/DeepSeek-R1", {
      baseUrl: "https://router.huggingface.co/v1",
      reasoning: true,
      input: ["text"],
    });

    const result = await resolveModelForTest(
      "huggingface",
      "huggingface/deepseek-ai/DeepSeek-R1",
      state.agentDir(),
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "huggingface",
      id: "deepseek-ai/DeepSeek-R1",
      reasoning: true,
      input: ["text"],
    });
  });

  it("preloads OpenRouter capabilities before first async resolve of an unknown model", async () => {
    mockLoadOpenRouterModelCapabilities.mockImplementation(async (modelId) => {
      if (modelId === "google/gemini-3.1-flash-image-preview") {
        mockGetOpenRouterModelCapabilities.mockReturnValue({
          name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 65536,
          maxTokens: 65536,
          cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
        });
      }
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "google/gemini-3.1-flash-image-preview",
      state.agentDir(),
    );

    expect(mockLoadOpenRouterModelCapabilities).toHaveBeenCalledWith(
      "google/gemini-3.1-flash-image-preview",
    );
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "google/gemini-3.1-flash-image-preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 65536,
      maxTokens: 65536,
    });
  });

  it("skips OpenRouter preload for models already present in the registry", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openrouter/healer-alpha",
      templateModel: {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "openrouter/healer-alpha",
      state.agentDir(),
    );

    expect(mockLoadOpenRouterModelCapabilities).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
    });
  });

  it("threads the model id through inline configured transport normalization", async () => {
    const normalizeProviderTransportWithPlugin = vi.fn(() => undefined);
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: {
        ...createRuntimeHooks(),
        normalizeProviderTransportWithPlugin,
      },
    });

    expectResolvedModel(result);
    expect(normalizeProviderTransportWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5.5",
        context: expect.objectContaining({ modelId: "gpt-5.5" }),
      }),
    );
  });

  it("prefers configured provider api metadata over discovered registry model", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "onehub",
      modelId: "glm-5",
      templateModel: {
        id: "glm-5",
        name: "GLM-5 (cached)",
        provider: "onehub",
        api: "anthropic-messages",
        baseUrl: "https://old-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          onehub: {
            baseUrl: "http://new-provider.example.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("glm-5"),
                api: "openai-completions",
                reasoning: true,
                contextWindow: 198000,
                maxTokens: 16000,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("onehub", "glm-5", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "onehub",
      id: "glm-5",
      api: "openai-completions",
      baseUrl: "http://new-provider.example.com/v1",
      reasoning: true,
      contextWindow: 198000,
      maxTokens: 16000,
    });
  });

  it("prefers exact provider config over normalized alias match when both keys exist", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "bedrock",
      modelId: "bedrock-alias-exact-test",
      templateModel: {
        id: "bedrock-alias-exact-test",
        name: "Bedrock alias test",
        provider: "bedrock",
        api: "openai-completions",
        baseUrl: "https://default-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://canonical-bedrock.example.com/v1",
            api: "openai-completions",
            headers: { "X-Provider": "canonical" },
            models: [{ ...makeModel("bedrock-alias-exact-test"), reasoning: false }],
          },
          bedrock: {
            baseUrl: "https://alias-bedrock.example.com/v1",
            api: "anthropic-messages",
            headers: { "X-Provider": "alias" },
            models: [
              {
                ...makeModel("bedrock-alias-exact-test"),
                api: "anthropic-messages",
                reasoning: true,
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest(
      "bedrock",
      "bedrock-alias-exact-test",
      state.agentDir(),
      cfg,
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "bedrock",
      id: "bedrock-alias-exact-test",
      api: "anthropic-messages",
      baseUrl: "https://alias-bedrock.example.com",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32768,
      headers: { "X-Provider": "alias" },
    });
  });

  it("builds an openai fallback for gpt-5.4", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("upgrades stale exact openai gpt-5.4 registry metadata via forward-compat", async () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai") {
          return null;
        }
        if (modelId === "gpt-5.4") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.4",
            name: "GPT-5.4",
            contextWindow: 272000,
          };
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128000,
    });
  });

  it("accepts available exact openai gpt-5.3-codex registry metadata", async () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai") {
          return null;
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            contextWindow: 272000,
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = await resolveModelForTest("openai", "gpt-5.3-codex", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.3-codex",
      contextWindow: 272000,
    });
  });

  it("canonicalizes the legacy openai gpt-5.4-codex alias at runtime", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = await resolveModelForTest("openai", "gpt-5.4-codex", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.name).toBe("gpt-5.4");
  });

  it("applies canonical openai overrides when resolving the gpt-5.4-codex alias", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 123456,
                contextTokens: 65432,
                maxTokens: 7777,
                reasoning: false,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-codex", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/backend-api",
      contextWindow: 123456,
      contextTokens: 65432,
      maxTokens: 7777,
      reasoning: false,
    });
  });

  it("prefers alias-specific overrides over canonical ones for gpt-5.4-codex", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 222222,
                maxTokens: 22222,
              },
              {
                ...makeModel("gpt-5.4-codex"),
                contextWindow: 111111,
                maxTokens: 11111,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-codex", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 111111,
      maxTokens: 11111,
    });
  });

  it("builds an openai fallback for gpt-5.4-mini", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = await resolveModelForTest("openai", "gpt-5.4-mini", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
      contextWindow: 400_000,
      contextTokens: 272_000,
    });
  });

  it("does not build an openai fallback for removed gpt-5.3-codex-spark", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = await resolveModelForTest("openai", "gpt-5.3-codex-spark", state.agentDir());

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("does not build a configured fallback for unsupported xAI multi-agent models", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    });

    const result = await resolveModelForTest(
      "xai",
      "grok-4.20-multi-agent-0309",
      state.agentDir(),
      cfg,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: xai/grok-4.20-multi-agent-0309. OpenClaw does not currently support xAI multi-agent models; choose another xAI model. See https://docs.openclaw.ai/providers/xai.",
    );
  });

  it("rejects stale openai gpt-5.3-codex-spark discovery rows", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.3-codex-spark", { input: ["text"] });

    const result = await resolveModelForTest("openai", "gpt-5.3-codex-spark", state.agentDir());

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("prefers runtime-resolved openai gpt-5.4 metadata when it has a larger context window", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4", {
      contextWindow: 128_000,
      contextTokens: 32_000,
      input: ["text"],
    });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("lets official openai metadata override stale configured model rows", async () => {
    mockOpenAIForwardCompatDiscovery();

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.5-pro"),
                api: "openai-chatgpt-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 400_000,
                contextTokens: 64_000,
                maxTokens: 32_000,
                metadataSource: "models-add",
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("openai", "gpt-5.5-pro", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves openai gpt-5.5 through the direct API fallback when discovery omits OAuth metadata", async () => {
    const result = await resolveModelForTest("openai", "gpt-5.5");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("preserves unmarked manual openai metadata overrides", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.5", {
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 400_000,
    });

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-chatgpt-responses",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "openai-chatgpt-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
                contextWindow: 555_555,
                contextTokens: 111_111,
                maxTokens: 22_222,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("openai", "gpt-5.5", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
      contextWindow: 555_555,
      contextTokens: 111_111,
      maxTokens: 22_222,
    });
  });

  it("prefers runtime-resolved openai gpt-5.4 metadata during async resolution too", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4", {
      contextWindow: 128_000,
      contextTokens: 32_000,
    });

    const result = await resolveModelAsyncForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("normalizes stale discovered openai /backend-api/v1 metadata", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4", {
      baseUrl: "https://chatgpt.com/backend-api/v1",
    });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes stale discovered openrouter /v1 metadata", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      templateModel: {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    });

    const result = await resolveModelForTest("openrouter", "openai/gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "openai/gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("normalizes discovered openai metadata when api is missing", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4", { api: undefined });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("passes configured workspaceDir to runtime preference hooks", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4", {
      contextWindow: 128_000,
      contextTokens: 32_000,
    });

    const shouldPreferRuntimeResolvedModel = vi.fn(
      (params: { workspaceDir?: string; context: { agentDir?: string } }) =>
        params.workspaceDir === state.workspaceDir &&
        params.context.agentDir === state.agentDir("state"),
    );
    const runProviderDynamicModel = vi.fn(
      (params: { workspaceDir?: string; context: { provider: string; modelId: string } }) =>
        params.workspaceDir === state.workspaceDir &&
        params.context.provider === "openai" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      shouldPreferProviderRuntimeResolvedModel: shouldPreferRuntimeResolvedModel,
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
        },
      },
    } as OpenClawConfig;

    const result = await resolveModelAsync("openai", "gpt-5.4", state.agentDir("state"), cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir("state")),
      runtimeHooks,
    });

    const preferInput = mockCallArg(shouldPreferRuntimeResolvedModel);
    expectRecordFields(preferInput, {
      provider: "openai",
      workspaceDir: state.workspaceDir,
    });
    expectRecordFields(preferInput.context, {
      agentDir: state.agentDir("state"),
      workspaceDir: state.workspaceDir,
    });
    const dynamicInput = mockCallArg(runProviderDynamicModel);
    expectRecordFields(dynamicInput, {
      provider: "openai",
      workspaceDir: state.workspaceDir,
    });
    expectRecordFields(dynamicInput.context, {
      agentDir: state.agentDir("state"),
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("passes configured workspaceDir through direct registry dynamic hooks", () => {
    const runProviderDynamicModel = vi.fn(
      (params: {
        workspaceDir?: string;
        context: { workspaceDir?: string; provider: string; modelId: string };
      }) =>
        params.workspaceDir === state.workspaceDir &&
        params.context.workspaceDir === state.workspaceDir &&
        params.context.provider === "openai" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
        },
      },
    } as OpenClawConfig;

    const result = resolveModelWithRegistry({
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: state.agentDir("state"),
      cfg,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir("state")),
      runtimeHooks,
    });

    const dynamicInput = mockCallArg(runProviderDynamicModel);
    expectRecordFields(dynamicInput, {
      workspaceDir: state.workspaceDir,
    });
    expectRecordFields(dynamicInput.context, {
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir("state"),
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expectRecordFields(result, {
      provider: "openai",
      id: "gpt-5.4",
    });
  });

  it("resolves discovered openai gpt-5.4-mini rows", async () => {
    mockOpenAIForwardCompatDiscovery("gpt-5.4-mini", {
      contextWindow: 64_000,
      input: ["text"],
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-mini", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      contextWindow: 64_000,
      input: ["text"],
    });
  });

  it("rejects stale direct openai gpt-5.3-codex-spark discovery rows", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = await resolveModelForTest("openai", "gpt-5.3-codex-spark", state.agentDir());

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it.each(["provider", "model"])(
    "preserves authored %s transport and model overrides",
    async (scope) => {
      const { buildOpenAIProvider } = await loadBundledPluginPublicSurface<{
        buildOpenAIProvider: () => ProviderPlugin;
      }>({ pluginId: "openai", artifactBasename: "api.js" });
      const provider = buildOpenAIProvider();
      const modelId = "gpt-5.6-luna";
      const route = { api: "openai-completions", baseUrl: "https://proxy.example/v1" } as const;
      const providerConfig: ModelProviderConfig = {
        baseUrl: "https://api.openai.com/v1",
        ...(scope === "provider" ? route : {}),
        headers: { "X-Provider-Route": "authored" },
        models: [
          {
            id: modelId,
            name: "Authored Luna",
            ...(scope === "model" ? route : {}),
            headers: { "X-Model-Route": "authored" },
            compat: { codeMode: "capable", supportsTemperature: true },
            reasoning: false,
            input: ["text"],
            contextWindow: 64_000,
            maxTokens: 4_000,
            cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      };
      const config = { models: { providers: { openai: providerConfig } } };
      const discoveredModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        providerConfig,
        config,
        modelRegistry: {
          find: () => undefined,
          getAll: () => [],
          getAvailable: () => [],
          hasConfiguredAuth: () => false,
        },
      });
      if (!discoveredModel) {
        throw new Error("expected the OpenAI dynamic model");
      }
      expect(discoveredModel.compat?.codeMode).toBe("preferred");

      const model = applyConfiguredProviderOverrides({
        provider: "openai",
        modelId,
        discoveredModel,
        providerConfig,
        cfg: config,
        manifestAlias: { provider: "openai" },
        runtimeHooks: {
          buildProviderUnknownModelHintWithPlugin: ({ context }) =>
            provider.buildUnknownModelHint?.(context) ?? undefined,
          prepareProviderDynamicModel: async () => undefined,
          runProviderDynamicModel: ({ context }) => provider.resolveDynamicModel?.(context),
          normalizeProviderResolvedModelWithPlugin: ({ context }) =>
            provider.normalizeResolvedModel?.(context),
          normalizeProviderTransportWithPlugin: ({ context }) =>
            provider.normalizeTransport?.(context) ?? undefined,
        },
      });
      expect(model).toMatchObject({
        ...route,
        headers: { "X-Provider-Route": "authored", "X-Model-Route": "authored" },
        compat: { codeMode: "capable", supportsTemperature: true },
        reasoning: false,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 4_000,
        cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
      });
    },
  );

  it("applies provider overrides to openai gpt-5.4 forward-compat models", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
          },
        },
      },
    });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir(), cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    expectRecordFields(result.model?.headers, {
      "X-Proxy-Auth": "token-123",
    });
  });

  it("applies configured overrides to github-copilot dynamic models", async () => {
    const cfg = makeOpenClawConfigFixture({
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy-Auth": "token-123" },
            models: [
              {
                ...makeModel("gpt-5.4-mini"),
                reasoning: true,
                input: ["text"],
                contextWindow: 256000,
                maxTokens: 32000,
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest(
      "github-copilot",
      "gpt-5.4-mini",
      state.agentDir(),
      cfg,
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "github-copilot",
      id: "gpt-5.4-mini",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256000,
      maxTokens: 32000,
    });
    expectRecordFields((result.model as unknown as { headers?: Record<string, string> }).headers, {
      "X-Proxy-Auth": "token-123",
    });
  });

  it("resolves github-copilot Claude dynamic models to anthropic-messages by default", async () => {
    const result = await resolveModelForTest(
      "github-copilot",
      "claude-sonnet-4.6",
      state.agentDir(),
    );

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
      api: "anthropic-messages",
    });
  });

  it.each([
    { modelId: "claude-sonnet-4.6", expectedApi: "anthropic-messages" },
    { modelId: "gemini-3.1-pro-preview", expectedApi: "openai-completions" },
    { modelId: "gpt-5.4-mini", expectedApi: "openai-responses" },
  ] as const)(
    "preserves discovered $expectedApi transport for params-only github-copilot $modelId",
    async ({ modelId, expectedApi }) => {
      mockDiscoveredModel(discoverModels, {
        provider: "github-copilot",
        modelId,
        templateModel: {
          ...makeModel(modelId),
          provider: "github-copilot",
          api: expectedApi,
          baseUrl: "https://api.githubcopilot.com",
        },
      });
      const cfg = {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "",
              models: [],
              params: { temperature: 0.2 },
            },
          },
        },
      };

      const result = await resolveModelForTest("github-copilot", modelId, state.agentDir(), cfg);

      expect(result.error).toBeUndefined();
      expectRecordFields(result.model, {
        provider: "github-copilot",
        id: modelId,
        api: expectedApi,
        params: { temperature: 0.2 },
      });
    },
  );

  it("builds an openai fallback for gpt-5.5 when the live catalog cache is cold", async () => {
    const result = await resolveModelForTest("openai", "gpt-5.5", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
    });
  });

  it("builds an openai fallback for gpt-5.4 mini from the gpt-5.4-mini template", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-mini", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("builds an openai fallback for gpt-5.4 nano from the gpt-5.4-nano template", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-nano",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-nano", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes stale native openai gpt-5.4 completions transport to responses", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps proxied openai completions transport untouched", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      }),
    });

    const result = await resolveModelForTest("openai", "gpt-5.4", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
    });
  });

  it("normalizes stale native xai completions transport to responses", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.20-0309-reasoning",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 0309 (Reasoning)",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = await resolveModelForTest("xai", "grok-4.20-0309-reasoning", state.agentDir());

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "xai",
      id: "grok-4.20-0309-reasoning",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("normalizes stale native xai completions transport after plugin model normalization", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.3",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = await resolveModelAsync("xai", "grok-4.3-latest", state.agentDir(), undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: {
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        prepareProviderDynamicModel: async () => {},
        runProviderDynamicModel: () => undefined,
        applyProviderResolvedTransportWithPlugin: ({ provider, context }) =>
          provider === "xai" &&
          context.model.api === "openai-completions" &&
          context.model.baseUrl === "https://api.x.ai/v1"
            ? {
                ...context.model,
                api: "openai-responses",
              }
            : undefined,
        normalizeProviderResolvedModelWithPlugin: ({ provider, context }) =>
          provider === "xai" ? (context.model as never) : undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
      },
    });

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "xai",
      id: "grok-4.3",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
