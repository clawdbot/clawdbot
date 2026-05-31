import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry as CoreModelRegistry } from "../../llm/model-registry.js";
import type { Api, Model } from "../../llm/types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  normalizeProviderResolvedModelWithPlugin,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";
import { discoverAuthStorage, discoverModels } from "../agent-model-discovery.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../auth-profiles.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { resolveModelWorkspaceDir } from "../model-discovery-context.js";
import { modelKey, normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldSuppressBuiltInModel,
  shouldUnconditionallySuppress,
} from "../model-suppression.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import {
  AuthStorage as AgentAuthStorageClass,
  ModelRegistry as AgentModelRegistryClass,
  type AuthStorage,
  type ModelRegistry,
} from "../sessions/index.js";
import { discoverCachedAgentStores } from "./model-discovery-cache.js";
import {
  buildInlineProviderModels,
  type InlineProviderConfig,
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";
import {
  canonicalizeManifestModelCatalogProviderAlias,
  resolveBundledStaticCatalogModel,
} from "./model.static-catalog.js";

type ProviderRuntimeHooks = {
  applyProviderResolvedTransportWithPlugin?: (
    params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
  ) => unknown;
  buildProviderUnknownModelHintWithPlugin: (
    params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0],
  ) => string | undefined;
  prepareProviderDynamicModel: (
    params: Parameters<typeof prepareProviderDynamicModel>[0],
  ) => Promise<void>;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  shouldPreferProviderRuntimeResolvedModel?: (
    params: Parameters<typeof shouldPreferProviderRuntimeResolvedModel>[0],
  ) => boolean;
  normalizeProviderResolvedModelWithPlugin: (
    params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
  ) => unknown;
  normalizeProviderTransportWithPlugin: typeof normalizeProviderTransportWithPlugin;
};

type StaticCatalogFallbackModel = Model & {
  compat?: ModelCompatConfig;
  contextTokens?: number;
  mediaInput?: ModelMediaInputConfig;
};

const TARGET_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  buildProviderUnknownModelHintWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
  normalizeProviderResolvedModelWithPlugin,
  // Target-provider resolution keeps owner hooks, but avoids broad
  // cross-provider hooks that can load unrelated bundled provider runtimes.
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

const DEFAULT_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderTransportWithPlugin,
};

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

const SKIP_AGENT_DISCOVERY_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  // skipAgentDiscovery is the lean path used before agent discovery/models.json has run.
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
};

function createEmptyAgentDiscoveryStores(): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const authStorage =
    typeof AgentAuthStorageClass.inMemory === "function"
      ? AgentAuthStorageClass.inMemory({})
      : AgentAuthStorageClass.create();
  const modelRegistry =
    typeof AgentModelRegistryClass.inMemory === "function"
      ? AgentModelRegistryClass.inMemory(authStorage)
      : AgentModelRegistryClass.create(authStorage);
  return { authStorage, modelRegistry };
}

function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  skipAgentDiscovery?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  if (params?.runtimeHooks) {
    return params.runtimeHooks;
  }
  if (params?.skipAgentDiscovery) {
    return SKIP_AGENT_DISCOVERY_PROVIDER_RUNTIME_HOOKS;
  }
  return DEFAULT_PROVIDER_RUNTIME_HOOKS;
}

function discoverCachedAgentStoresForAgent(
  resolvedAgentDir: string,
  cfg: OpenClawConfig | undefined,
  workspaceDir: string | undefined,
): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  return discoverCachedAgentStores({
    agentDir: resolvedAgentDir,
    ...(cfg ? { config: cfg } : {}),
    inheritedAuthDir: resolveDefaultAgentDir(cfg ?? {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

function canonicalizeLegacyResolvedModel(params: { provider: string; model: Model }): Model {
  if (
    normalizeProviderId(params.provider) !== "openai" ||
    params.model.id.trim().toLowerCase() !== "gpt-5.4-codex"
  ) {
    return params.model;
  }
  return {
    ...params.model,
    id: "gpt-5.4",
    name:
      params.model.name.trim().toLowerCase() === "gpt-5.4-codex" ? "gpt-5.4" : params.model.name,
  };
}

function applyResolvedTransportFallback(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
  model: Model;
}): Model | undefined {
  const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      api: params.model.api,
      baseUrl: params.model.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  if (!normalized) {
    return undefined;
  }
  const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return undefined;
  }
  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  };
}

function normalizeResolvedModel(params: {
  provider: string;
  model: Model;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model {
  const normalizeModelCost = (cost: unknown): Model["cost"] => {
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const record = cost as Partial<Model["cost"]>;
    const input =
      typeof record.input === "number" && Number.isFinite(record.input) ? record.input : 0;
    const output =
      typeof record.output === "number" && Number.isFinite(record.output) ? record.output : 0;
    const cacheRead =
      typeof record.cacheRead === "number" && Number.isFinite(record.cacheRead)
        ? record.cacheRead
        : 0;
    const cacheWrite =
      typeof record.cacheWrite === "number" && Number.isFinite(record.cacheWrite)
        ? record.cacheWrite
        : 0;
    if (
      input === record.input &&
      output === record.output &&
      cacheRead === record.cacheRead &&
      cacheWrite === record.cacheWrite
    ) {
      return record as Model["cost"];
    }
    return {
      ...cost,
      input,
      output,
      cacheRead,
      cacheWrite,
    };
  };

  const normalizedInputModel = {
    ...params.model,
    input: resolveProviderModelInput({
      provider: params.provider,
      modelId: params.model.id,
      modelName: params.model.name,
      input: params.model.input,
    }),
    cost: normalizeModelCost((params.model as { cost?: unknown }).cost),
  } as Model;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: normalizedInputModel,
    },
  }) as Model | undefined;
  const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: (pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeHooks,
      model: pluginNormalized ?? normalizedInputModel,
    });
  return canonicalizeLegacyResolvedModel({
    provider: params.provider,
    model: normalizeResolvedProviderModel({
      provider: params.provider,
      model: fallbackTransportNormalized ?? pluginNormalized ?? normalizedInputModel,
    }),
  });
}

function resolveProviderTransport(params: {
  provider: string;
  api?: Api | null;
  baseUrl?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): {
  api?: Api;
  baseUrl?: string;
} {
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      api: params.api,
      baseUrl: params.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;

  return {
    api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
    baseUrl: normalized?.baseUrl ?? params.baseUrl,
  };
}

function resolveConfiguredProviderDefaultApi(
  providerConfig: InlineProviderConfig | undefined,
): Api | undefined {
  const explicit = normalizeResolvedTransportApi(providerConfig?.api);
  if (explicit) {
    return explicit;
  }
  return providerConfig?.baseUrl ? "openai-completions" : undefined;
}

function resolveProviderRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
}

function mergeModelMediaInput(
  base: ModelMediaInputConfig | undefined,
  override: ModelMediaInputConfig | undefined,
): ModelMediaInputConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    image:
      base.image || override.image
        ? {
            ...base.image,
            ...override.image,
          }
        : undefined,
  };
}

function matchesProviderScopedModelId(params: {
  candidateId?: string;
  provider: string;
  modelId: string;
}): boolean {
  const { candidateId, provider, modelId } = params;
  if (candidateId === modelId) {
    return true;
  }
  const slashIndex = candidateId?.indexOf("/") ?? -1;
  if (!candidateId || slashIndex <= 0) {
    return false;
  }
  const candidateProvider = candidateId.slice(0, slashIndex);
  const candidateModelId = candidateId.slice(slashIndex + 1);
  return (
    candidateModelId === modelId &&
    normalizeProviderId(candidateProvider) === normalizeProviderId(provider)
  );
}

function findInlineModelMatch(params: {
  providers: Record<string, InlineProviderConfig>;
  provider: string;
  modelId: string;
}) {
  const matchesModelId = (entry: { provider: string; id?: string }) =>
    matchesProviderScopedModelId({
      candidateId: entry.id,
      provider: entry.provider,
      modelId: params.modelId,
    });
  const inlineModels = buildInlineProviderModels(params.providers);
  const exact = inlineModels.find(
    (entry) => entry.provider === params.provider && matchesModelId(entry),
  );
  if (exact) {
    return exact;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  return inlineModels.find(
    (entry) => normalizeProviderId(entry.provider) === normalizedProvider && matchesModelId(entry),
  );
}

export { buildModelAliasLines, buildInlineProviderModels };

function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  const configuredProviders = cfg?.models?.providers;
  if (!configuredProviders) {
    return undefined;
  }
  const exactProviderConfig = configuredProviders[provider];
  if (exactProviderConfig) {
    return exactProviderConfig;
  }
  return findNormalizedProviderValue(configuredProviders, provider);
}

function isModelsAddMetadataModel(params: {
  model: NonNullable<InlineProviderConfig["models"]>[number] | undefined;
}) {
  return (
    (params.model as { metadataSource?: unknown } | undefined)?.metadataSource === "models-add"
  );
}

function findConfiguredProviderModel(
  providerConfig: InlineProviderConfig | undefined,
  provider: string,
  modelId: string,
) {
  return providerConfig?.models?.find((candidate) =>
    matchesProviderScopedModelId({
      candidateId: candidate.id,
      provider,
      modelId,
    }),
  );
}

function hasConfiguredFallbackSurface(params: {
  providerConfig: InlineProviderConfig | undefined;
  configuredModel: ReturnType<typeof findConfiguredProviderModel>;
  modelId: string;
}): boolean {
  if (params.modelId.startsWith("mock-")) {
    return true;
  }
  if (params.configuredModel) {
    return true;
  }
  const baseUrl = params.providerConfig?.baseUrl?.trim();
  return Boolean(baseUrl);
}

function readModelParams(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mergeModelParams(
  ...entries: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...entries.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function findConfiguredAgentModelParams(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const configuredModels = params.cfg?.agents?.defaults?.models;
  if (!configuredModels) {
    return undefined;
  }
  const directKeys = [
    modelKey(params.provider, params.modelId),
    `${params.provider}/${params.modelId}`,
  ];
  for (const key of directKeys) {
    const direct = readModelParams(configuredModels[key]?.params);
    if (direct) {
      return direct;
    }
  }

  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModelId = normalizeStaticProviderModelId(normalizedProvider, params.modelId)
    .trim()
    .toLowerCase();
  for (const [rawKey, entry] of Object.entries(configuredModels)) {
    const slashIndex = rawKey.indexOf("/");
    if (slashIndex <= 0) {
      continue;
    }
    const candidateProvider = rawKey.slice(0, slashIndex);
    const candidateModelId = rawKey.slice(slashIndex + 1);
    if (
      normalizeProviderId(candidateProvider) === normalizedProvider &&
      normalizeStaticProviderModelId(normalizedProvider, candidateModelId).trim().toLowerCase() ===
        normalizedModelId
    ) {
      return readModelParams(entry.params);
    }
  }
  return undefined;
}

function mergeConfiguredRuntimeModelParams(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  discoveredParams?: unknown;
  providerParams?: unknown;
  configuredParams?: unknown;
}): Record<string, unknown> | undefined {
  return mergeModelParams(
    readModelParams(params.discoveredParams),
    readModelParams(params.providerParams),
    findConfiguredAgentModelParams({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
    }),
    readModelParams(params.configuredParams),
  );
}

function applyConfiguredProviderOverrides(params: {
  provider: string;
  discoveredModel: ProviderRuntimeModel;
  providerConfig?: InlineProviderConfig;
  modelId: string;
  cfg?: OpenClawConfig;
  runtimeHooks?: ProviderRuntimeHooks;
  preferDiscoveredModelMetadata?: boolean;
  workspaceDir?: string;
}): ProviderRuntimeModel {
  const { discoveredModel, providerConfig, modelId } = params;
  const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
  const defaultModelParams = findConfiguredAgentModelParams({
    cfg: params.cfg,
    provider: params.provider,
    modelId,
  });
  if (!providerConfig) {
    const resolvedParams = mergeModelParams(
      readModelParams(discoveredModel.params),
      defaultModelParams,
    );
    const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
      stripSecretRefMarkers: true,
    });
    const requestConfig = resolveProviderRequestConfig({
      provider: params.provider,
      api: discoveredModel.api,
      baseUrl: discoveredModel.baseUrl,
      discoveredHeaders,
      capability: "llm",
      transport: "stream",
    });
    return {
      ...discoveredModel,
      ...(resolvedParams ? { params: resolvedParams } : {}),
      // Discovered models originate from models.json and may contain persistence markers.
      headers: requestConfig.headers,
    };
  }
  const configuredModel =
    findConfiguredProviderModel(providerConfig, params.provider, modelId) ??
    (discoveredModel.id !== modelId
      ? findConfiguredProviderModel(providerConfig, params.provider, discoveredModel.id)
      : undefined);
  const metadataOverrideModel =
    params.preferDiscoveredModelMetadata && isModelsAddMetadataModel({ model: configuredModel })
      ? undefined
      : configuredModel;
  const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
    stripSecretRefMarkers: true,
  });
  const providerHeaders = sanitizeModelHeaders(providerConfig.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig.request);
  const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  const providerParams = readModelParams(providerConfig.params);
  const passthroughRequestConfig = resolveProviderRequestConfig({
    provider: params.provider,
    api: discoveredModel.api,
    baseUrl: discoveredModel.baseUrl,
    discoveredHeaders,
    providerHeaders,
    modelHeaders: configuredHeaders,
    authHeader: providerConfig.authHeader,
    request: providerRequest,
    capability: "llm",
    transport: "stream",
  });
  if (
    !configuredModel &&
    !providerConfig.baseUrl &&
    !providerConfig.api &&
    providerConfig.contextWindow === undefined &&
    providerConfig.contextTokens === undefined &&
    providerConfig.maxTokens === undefined &&
    requestTimeoutMs === undefined &&
    !providerHeaders &&
    !providerRequest &&
    !providerParams &&
    !providerConfig.localService
  ) {
    const resolvedParams = mergeModelParams(
      readModelParams(discoveredModel.params),
      defaultModelParams,
    );
    return {
      ...discoveredModel,
      ...(resolvedParams ? { params: resolvedParams } : {}),
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      headers: passthroughRequestConfig.headers,
    };
  }
  const resolvedParams = mergeModelParams(
    readModelParams(discoveredModel.params),
    providerParams,
    defaultModelParams,
    readModelParams(configuredModel?.params),
  );
  const normalizedInput = resolveProviderModelInput({
    provider: params.provider,
    modelId,
    modelName: metadataOverrideModel?.name ?? discoveredModel.name,
    input: metadataOverrideModel?.input,
    fallbackInput: discoveredModel.input,
  });

  const resolvedTransport = resolveProviderTransport({
    provider: params.provider,
    api:
      metadataOverrideModel?.api ??
      providerConfig.api ??
      discoveredModel.api ??
      resolveConfiguredProviderDefaultApi(providerConfig),
    baseUrl: metadataOverrideModel?.baseUrl ?? providerConfig.baseUrl ?? discoveredModel.baseUrl,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.runtimeHooks,
  });
  const resolvedContextWindow =
    metadataOverrideModel?.contextWindow ?? providerConfig.contextWindow;
  const resolvedMaxTokens =
    metadataOverrideModel?.maxTokens ?? providerConfig.maxTokens ?? discoveredModel.maxTokens;
  const resolvedCompat = mergeModelCompat(discoveredModel.compat, metadataOverrideModel?.compat);
  const resolvedReasoning = resolveMergedConfiguredModelReasoning({
    provider: params.provider,
    configuredCompat: metadataOverrideModel?.compat,
    resolvedCompat,
    configuredReasoning: metadataOverrideModel?.reasoning,
    discoveredReasoning: discoveredModel.reasoning,
  });
  const requestConfig = resolveProviderRequestConfig({
    provider: params.provider,
    api:
      resolvedTransport.api ??
      normalizeResolvedTransportApi(discoveredModel.api) ??
      resolveConfiguredProviderDefaultApi(providerConfig) ??
      "openai-responses",
    baseUrl: resolvedTransport.baseUrl ?? discoveredModel.baseUrl,
    discoveredHeaders,
    providerHeaders,
    modelHeaders: configuredHeaders,
    authHeader: providerConfig.authHeader,
    request: providerRequest,
    capability: "llm",
    transport: "stream",
  });
  return attachModelProviderLocalService(
    attachModelProviderRequestTransport(
      {
        ...discoveredModel,
        api: requestConfig.api ?? "openai-responses",
        baseUrl: requestConfig.baseUrl ?? discoveredModel.baseUrl,
        reasoning: resolvedReasoning,
        input: normalizedInput,
        cost: metadataOverrideModel?.cost ?? discoveredModel.cost,
        contextWindow: resolvedContextWindow ?? discoveredModel.contextWindow,
        contextTokens:
          metadataOverrideModel?.contextTokens ??
          providerConfig.contextTokens ??
          discoveredModel.contextTokens,
        maxTokens:
          typeof resolvedContextWindow === "number"
            ? Math.min(resolvedMaxTokens, resolvedContextWindow)
            : resolvedMaxTokens,
        ...(resolvedParams ? { params: resolvedParams } : {}),
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        headers: requestConfig.headers,
        compat: resolvedCompat,
        mediaInput: mergeModelMediaInput(
          discoveredModel.mediaInput,
          metadataOverrideModel?.mediaInput,
        ),
      },
      providerRequest,
    ),
    providerConfig.localService,
  );
}
function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { kind: "resolved"; model: Model } | { kind: "suppressed" } | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
  const inlineMatch = findInlineModelMatch({
    providers: cfg?.models?.providers ?? {},
    provider,
    modelId,
  });
  if (inlineMatch?.api) {
    // Unconditional suppressions (no `when` clause) represent absolute provider
    // capability blocks that cannot be overridden by inline user configuration.
    // Conditional suppressions (e.g. baseUrlHosts-gated qwen restrictions) are
    // intentionally bypassable when the user has explicitly configured the model.
    // (#74451)
    if (
      shouldUnconditionallySuppress({
        provider,
        id: modelId,
        ...(cfg ? { config: cfg } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      })
    ) {
      return { kind: "suppressed" };
    }
    const resolvedParams = mergeConfiguredRuntimeModelParams({
      cfg,
      provider,
      modelId,
      providerParams: providerConfig?.params,
      configuredParams: inlineMatch.params,
    });
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        workspaceDir,
        model: {
          ...inlineMatch,
          reasoning: resolveConfiguredModelReasoning({
            provider,
            compat: inlineMatch.compat,
            reasoning: inlineMatch.reasoning,
          }),
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        } as Model,
        runtimeHooks,
      }),
    };
  }
  if (
    shouldSuppressBuiltInModel({
      provider,
      id: modelId,
      ...(cfg ? { config: cfg } : {}),
      ...(providerConfig?.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    })
  ) {
    return { kind: "suppressed" };
  }
  const model = modelRegistry.find(provider, modelId) as Model | null;

  if (model) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        workspaceDir,
        model: applyConfiguredProviderOverrides({
          provider,
          discoveredModel: model,
          providerConfig,
          modelId,
          cfg,
          runtimeHooks,
          workspaceDir,
        }),
        runtimeHooks,
      }),
    };
  }

  const providers = cfg?.models?.providers ?? {};
  const fallbackInlineMatch = findInlineModelMatch({
    providers,
    provider,
    modelId,
  });
  if (fallbackInlineMatch?.api) {
    const resolvedParams = mergeConfiguredRuntimeModelParams({
      cfg,
      provider,
      modelId,
      providerParams: providerConfig?.params,
      configuredParams: fallbackInlineMatch.params,
    });
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        workspaceDir,
        model: {
          ...fallbackInlineMatch,
          reasoning: resolveConfiguredModelReasoning({
            provider,
            compat: fallbackInlineMatch.compat,
            reasoning: fallbackInlineMatch.reasoning,
          }),
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        } as Model,
        runtimeHooks,
      }),
    };
  }

  return undefined;
}

function resolveDynamicModelAuthProfile(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authProfileId?: string;
  preferredProfile?: string;
}): {
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
} {
  const explicitProfileId = params.authProfileId?.trim() || undefined;
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  if (explicitProfileId) {
    const credential = store.profiles[explicitProfileId];
    const configuredMode = params.cfg?.auth?.profiles?.[explicitProfileId]?.mode;
    return {
      authProfileId: explicitProfileId,
      ...(credential?.type || configuredMode
        ? { authProfileMode: credential?.type ?? configuredMode }
        : {}),
    };
  }
  const order = [
    ...new Set(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: params.provider,
        config: params.cfg,
      }).flatMap((provider) =>
        resolveAuthProfileOrder({
          cfg: params.cfg,
          store,
          provider,
          preferredProfile: params.preferredProfile,
        }),
      ),
    ),
  ];
  const profileId = order[0];
  if (!profileId) {
    return {};
  }
  const credential = store.profiles[profileId];
  const configuredMode = params.cfg?.auth?.profiles?.[profileId]?.mode;
  return {
    authProfileId: profileId,
    ...(credential?.type || configuredMode
      ? { authProfileMode: credential?.type ?? configuredMode }
      : {}),
  };
}

function resolvePluginDynamicModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  authProfileId?: string;
  preferredProfile?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const authProfile = resolveDynamicModelAuthProfile({
    provider,
    cfg,
    agentDir,
    authProfileId: params.authProfileId,
    preferredProfile: params.preferredProfile,
  });
  const preferDiscoveredModelMetadata = shouldCompareProviderRuntimeResolvedModel({
    provider,
    modelId,
    cfg,
    agentDir,
    workspaceDir,
    runtimeHooks,
  });
  const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
    provider,
    config: cfg,
    workspaceDir,
    context: {
      config: cfg,
      agentDir,
      workspaceDir,
      provider,
      modelId,
      modelRegistry,
      providerConfig,
      ...authProfile,
    },
  }) as Model | undefined;
  if (!pluginDynamicModel) {
    return undefined;
  }
  const overriddenDynamicModel = applyConfiguredProviderOverrides({
    provider,
    discoveredModel: pluginDynamicModel,
    providerConfig,
    modelId,
    cfg,
    runtimeHooks,
    workspaceDir,
    preferDiscoveredModelMetadata,
  });
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: overriddenDynamicModel,
    runtimeHooks,
  });
}

function resolveConfiguredFallbackModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model | undefined {
  const { provider, modelId, cfg, agentDir, workspaceDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
  const configuredModel = findConfiguredProviderModel(providerConfig, provider, modelId);
  if (!hasConfiguredFallbackSurface({ providerConfig, configuredModel, modelId })) {
    return undefined;
  }
  const staticCatalogModel = configuredModel
    ? undefined
    : (resolveBundledStaticCatalogModel({
        provider,
        modelId,
        cfg,
        workspaceDir,
        includeRuntimeDiscovery: true,
      }) as StaticCatalogFallbackModel | undefined);
  const metadataModel = configuredModel ?? staticCatalogModel;
  const fallbackCompat = configuredModel?.compat ?? staticCatalogModel?.compat;
  const fallbackMediaInput = configuredModel?.mediaInput ?? staticCatalogModel?.mediaInput;
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  const modelHeaders = sanitizeModelHeaders(metadataModel?.headers, {
    stripSecretRefMarkers: true,
  });
  const resolvedParams = mergeConfiguredRuntimeModelParams({
    cfg,
    provider,
    modelId,
    providerParams: providerConfig?.params,
    configuredParams: configuredModel?.params,
  });
  const fallbackTransport = resolveProviderTransport({
    provider,
    api:
      normalizeResolvedTransportApi(configuredModel?.api) ??
      resolveConfiguredProviderDefaultApi(providerConfig) ??
      normalizeResolvedTransportApi(staticCatalogModel?.api) ??
      "openai-responses",
    baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl ?? staticCatalogModel?.baseUrl,
    cfg,
    workspaceDir,
    runtimeHooks,
  });
  const requestConfig = resolveProviderRequestConfig({
    provider,
    api: fallbackTransport.api ?? "openai-responses",
    baseUrl: fallbackTransport.baseUrl,
    providerHeaders,
    modelHeaders,
    authHeader: providerConfig?.authHeader,
    request: providerRequest,
    capability: "llm",
    transport: "stream",
  });
  const fallbackReasoning = resolveConfiguredFallbackReasoning({
    provider,
    compat: fallbackCompat,
    reasoning: metadataModel?.reasoning,
  });
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: attachModelProviderLocalService(
      attachModelProviderRequestTransport(
        {
          id: modelId,
          name: metadataModel?.name ?? modelId,
          api: requestConfig.api ?? "openai-responses",
          provider,
          baseUrl: requestConfig.baseUrl,
          reasoning: fallbackReasoning,
          input: resolveProviderModelInput({
            provider,
            modelId,
            modelName: metadataModel?.name ?? modelId,
            input: metadataModel?.input,
          }),
          cost: metadataModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow:
            configuredModel?.contextWindow ??
            providerConfig?.contextWindow ??
            providerConfig?.models?.[0]?.contextWindow ??
            staticCatalogModel?.contextWindow ??
            DEFAULT_CONTEXT_TOKENS,
          contextTokens:
            configuredModel?.contextTokens ??
            providerConfig?.contextTokens ??
            providerConfig?.models?.[0]?.contextTokens ??
            staticCatalogModel?.contextTokens,
          maxTokens:
            configuredModel?.maxTokens ??
            providerConfig?.maxTokens ??
            providerConfig?.models?.[0]?.maxTokens ??
            staticCatalogModel?.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          headers: requestConfig.headers,
          compat: fallbackCompat,
          mediaInput: fallbackMediaInput,
        } as Model,
        providerRequest,
      ),
      providerConfig?.localService,
    ),
    runtimeHooks,
  });
}

function shouldCompareProviderRuntimeResolvedModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
}): boolean {
  return (
    params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
      provider: params.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      context: {
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      },
    }) ?? false
  );
}

function resolveConfiguredFallbackReasoning(params: {
  provider: string;
  compat?: unknown;
  reasoning?: boolean;
}): boolean {
  return resolveConfiguredModelReasoning(params) ?? false;
}

function resolveConfiguredModelReasoning(params: {
  provider: string;
  compat?: unknown;
  reasoning?: boolean;
}): boolean | undefined {
  if (params.reasoning !== undefined) {
    return params.reasoning;
  }
  return isVllmQwenThinkingCompat(params) ? true : undefined;
}

function resolveMergedConfiguredModelReasoning(params: {
  provider: string;
  configuredCompat?: unknown;
  resolvedCompat?: unknown;
  configuredReasoning?: boolean;
  discoveredReasoning?: boolean;
}): boolean {
  if (params.configuredReasoning !== undefined) {
    return params.configuredReasoning;
  }
  if (isVllmQwenThinkingCompat({ provider: params.provider, compat: params.configuredCompat })) {
    return true;
  }
  return (
    resolveConfiguredModelReasoning({
      provider: params.provider,
      compat: params.resolvedCompat,
      reasoning: params.discoveredReasoning,
    }) ?? false
  );
}

function isVllmQwenThinkingCompat(params: { provider: string; compat?: unknown }): boolean {
  const thinkingFormat = readCompatThinkingFormat(params.compat);
  return (
    normalizeProviderId(params.provider) === "vllm" &&
    (thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template")
  );
}

function readCompatThinkingFormat(compat: unknown): string | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  const thinkingFormat = (compat as { thinkingFormat?: unknown }).thinkingFormat;
  return typeof thinkingFormat === "string" ? thinkingFormat : undefined;
}

function mergeModelCompat(
  base: ModelCompatConfig | undefined,
  override: ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return { ...base, ...override };
}

function preferProviderRuntimeResolvedModel(params: {
  explicitModel: Model;
  runtimeResolvedModel?: Model;
}): Model {
  if (params.runtimeResolvedModel) {
    return params.runtimeResolvedModel;
  }
  return params.explicitModel;
}

function normalizeProviderModelRef(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): { provider: string; model: string } {
  const provider = canonicalizeManifestModelCatalogProviderAlias({
    provider: params.provider,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  return {
    provider,
    model: normalizeStaticProviderModelId(normalizeProviderId(provider), params.modelId),
  };
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  authProfileId?: string;
  preferredProfile?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model | undefined {
  const workspaceDir = params.workspaceDir ?? params.cfg?.agents?.defaults?.workspace;
  const normalizedRef = normalizeProviderModelRef({ ...params, workspaceDir });
  const normalizedParams = {
    ...params,
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
  };
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const scopedParams = {
    ...normalizedParams,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
  };
  const explicitModel = resolveExplicitModelWithRegistry(scopedParams);
  if (explicitModel?.kind === "suppressed") {
    return undefined;
  }
  if (explicitModel?.kind === "resolved") {
    if (
      !shouldCompareProviderRuntimeResolvedModel({
        provider: scopedParams.provider,
        modelId: scopedParams.modelId,
        cfg: scopedParams.cfg,
        agentDir: scopedParams.agentDir,
        workspaceDir,
        runtimeHooks,
      })
    ) {
      return explicitModel.model;
    }
    const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(scopedParams);
    return preferProviderRuntimeResolvedModel({
      explicitModel: explicitModel.model,
      runtimeResolvedModel: pluginDynamicModel,
    });
  }
  const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(scopedParams);
  if (pluginDynamicModel) {
    return pluginDynamicModel;
  }

  return resolveConfiguredFallbackModel(scopedParams);
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
    workspaceDir?: string;
    authProfileId?: string;
    preferredProfile?: string;
  },
): {
  model?: Model;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const workspaceDir = resolveModelWorkspaceDir(cfg, options?.workspaceDir);
  const normalizedRef = normalizeProviderModelRef({ provider, modelId, cfg, workspaceDir });
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const cachedStores =
    !options?.authStorage && !options?.modelRegistry
      ? discoverCachedAgentStoresForAgent(resolvedAgentDir, cfg, workspaceDir)
      : undefined;
  const authStorage =
    options?.authStorage ?? cachedStores?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry =
    options?.modelRegistry ??
    cachedStores?.modelRegistry ??
    discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const model = resolveModelWithRegistry({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    workspaceDir,
    authProfileId: options?.authProfileId,
    preferredProfile: options?.preferredProfile,
    runtimeHooks,
  });
  if (model) {
    return { model, authStorage, modelRegistry };
  }

  return {
    error: buildUnknownModelError({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

export async function resolveModelAsync(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    allowBundledStaticCatalogFallback?: boolean;
    retryTransientProviderRuntimeMiss?: boolean;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
    skipAgentDiscovery?: boolean;
    workspaceDir?: string;
    authProfileId?: string;
    preferredProfile?: string;
  },
): Promise<{
  model?: Model;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}> {
  const workspaceDir = resolveModelWorkspaceDir(cfg, options?.workspaceDir);
  const normalizedRef = normalizeProviderModelRef({ provider, modelId, cfg, workspaceDir });
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const emptyDiscoveryStores =
    options?.skipAgentDiscovery && (!options.authStorage || !options.modelRegistry)
      ? createEmptyAgentDiscoveryStores()
      : undefined;
  const cachedStores =
    !emptyDiscoveryStores && !options?.authStorage && !options?.modelRegistry
      ? discoverCachedAgentStoresForAgent(resolvedAgentDir, cfg, workspaceDir)
      : undefined;
  const authStorage =
    options?.authStorage ??
    emptyDiscoveryStores?.authStorage ??
    cachedStores?.authStorage ??
    discoverAuthStorage(resolvedAgentDir);
  const modelRegistry =
    options?.modelRegistry ??
    emptyDiscoveryStores?.modelRegistry ??
    cachedStores?.modelRegistry ??
    discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const explicitModel = resolveExplicitModelWithRegistry({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    workspaceDir,
    runtimeHooks,
  });
  if (explicitModel?.kind === "suppressed") {
    return {
      error: buildUnknownModelError({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        runtimeHooks,
      }),
      authStorage,
      modelRegistry,
    };
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, normalizedRef.provider);
  const authProfile = resolveDynamicModelAuthProfile({
    provider: normalizedRef.provider,
    cfg,
    agentDir: resolvedAgentDir,
    authProfileId: options?.authProfileId,
    preferredProfile: options?.preferredProfile,
  });
  const resolveDynamicAttempt = async () => {
    await runtimeHooks.prepareProviderDynamicModel({
      provider: normalizedRef.provider,
      config: cfg,
      workspaceDir,
      context: {
        config: cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        modelRegistry,
        providerConfig,
        ...authProfile,
      },
    });
    return resolveModelWithRegistry({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      modelRegistry,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      authProfileId: options?.authProfileId,
      preferredProfile: options?.preferredProfile,
      runtimeHooks,
    });
  };
  let model =
    explicitModel?.kind === "resolved" &&
    !shouldCompareProviderRuntimeResolvedModel({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      runtimeHooks,
    })
      ? explicitModel.model
      : await resolveDynamicAttempt();
  if (!model && !explicitModel && options?.retryTransientProviderRuntimeMiss) {
    // Startup can race the first provider-runtime snapshot load on a fresh
    // gateway boot. Retry once before surfacing a user-visible "Unknown model"
    // that disappears on the next message.
    model = await resolveDynamicAttempt();
  }
  if (!model && !explicitModel && options?.allowBundledStaticCatalogFallback) {
    const staticCatalogModel = resolveBundledStaticCatalogModel({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      workspaceDir,
    });
    if (staticCatalogModel) {
      const overriddenStaticCatalogModel = applyConfiguredProviderOverrides({
        provider: normalizedRef.provider,
        discoveredModel: staticCatalogModel,
        providerConfig,
        modelId: normalizedRef.model,
        cfg,
        runtimeHooks,
        workspaceDir,
        preferDiscoveredModelMetadata: true,
      });
      model = normalizeResolvedModel({
        provider: normalizedRef.provider,
        cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        model: overriddenStaticCatalogModel,
        runtimeHooks,
      });
    }
  }
  if (model && options?.allowBundledStaticCatalogFallback) {
    const staticCatalogModel = resolveBundledStaticCatalogModel({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      workspaceDir,
    });
    const staticMediaInput = staticCatalogModel?.mediaInput;
    const resolvedMediaInput = (model as ProviderRuntimeModel).mediaInput;
    const mediaInput = mergeModelMediaInput(staticMediaInput, resolvedMediaInput);
    if (mediaInput) {
      model = { ...(model as ProviderRuntimeModel), mediaInput } as typeof model;
    }
  }
  if (model) {
    return { model, authStorage, modelRegistry };
  }

  return {
    error: buildUnknownModelError({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Some provider plugins only become available after setup/auth has registered
 * them. When users point `agents.defaults.model.primary` at one of those
 * providers before setup, the raw `Unknown model` error is too vague. Provider
 * plugins can append a targeted recovery hint here.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
function buildUnknownModelError(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): string {
  const suppressed = buildSuppressedBuiltInModelError({
    provider: params.provider,
    id: params.modelId,
    ...(params.cfg ? { config: params.cfg } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (suppressed) {
    return suppressed;
  }
  const base = `Unknown model: ${params.provider}/${params.modelId}`;
  const registrationHint = buildMissingProviderModelRegistrationHint({
    provider: params.provider,
    modelId: params.modelId,
    cfg: params.cfg,
  });
  if (registrationHint) {
    return `${base}. ${registrationHint}`;
  }
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const hint = runtimeHooks.buildProviderUnknownModelHintWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: params.provider,
      modelId: params.modelId,
    },
  });
  return hint ? `${base}. ${hint}` : base;
}

function buildMissingProviderModelRegistrationHint(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
}): string | undefined {
  const configuredModels = params.cfg?.agents?.defaults?.models;
  if (!configuredModels) {
    return undefined;
  }
  const agentModelKey = modelKey(params.provider, params.modelId);
  if (
    !configuredModels[agentModelKey] &&
    !configuredModels[`${params.provider}/${params.modelId}`]
  ) {
    return undefined;
  }
  const providerConfig = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.provider,
  ) as { models?: unknown } | undefined;
  const providerModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const hasProviderModel = providerModels.some((entry) => {
    if (!entry || typeof entry !== "object" || !("id" in entry)) {
      return false;
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id === params.modelId;
  });
  if (hasProviderModel) {
    return undefined;
  }
  return `Found agents.defaults.models["${agentModelKey}"], but no matching models.providers["${params.provider}"].models[] entry. Add { "id": "${params.modelId}" } to models.providers["${params.provider}"].models[] to register this provider model.`;
}
