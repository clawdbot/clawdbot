import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage as PiAuthStorageClass,
  ModelRegistry as PiModelRegistryClass,
  type AuthStorage,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  normalizeProviderResolvedModelWithPlugin,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { modelKey, normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldSuppressBuiltInModel,
  shouldUnconditionallySuppress,
} from "../model-suppression.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import {
  buildInlineProviderModels,
  type InlineProviderConfig,
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";
import { resolveBundledStaticCatalogModel } from "./model.static-catalog.js";

type ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins?: (
    params: Parameters<typeof applyProviderResolvedModelCompatWithPlugins>[0],
  ) => unknown;
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

const TARGET_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  buildProviderUnknownModelHintWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
  normalizeProviderResolvedModelWithPlugin,
  // Target-provider resolution keeps owner hooks, but avoids broad
  // cross-provider hooks that can load unrelated bundled provider runtimes.
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

const DEFAULT_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderTransportWithPlugin,
};

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

const SKIP_PI_DISCOVERY_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  // skipPiDiscovery is the lean path used before PI discovery/models.json has run.
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
};

function createEmptyPiDiscoveryStores(): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const authStorage =
    typeof PiAuthStorageClass.inMemory === "function"
      ? PiAuthStorageClass.inMemory({})
      : PiAuthStorageClass.create();
  const modelRegistry =
    typeof PiModelRegistryClass.inMemory === "function"
      ? PiModelRegistryClass.inMemory(authStorage)
      : PiModelRegistryClass.create(authStorage);
  return { authStorage, modelRegistry };
}

function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  skipPiDiscovery?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  if (params?.runtimeHooks) {
    return params.runtimeHooks;
  }
  if (params?.skipPiDiscovery) {
    return SKIP_PI_DISCOVERY_PROVIDER_RUNTIME_HOOKS;
  }
  return DEFAULT_PROVIDER_RUNTIME_HOOKS;
}

function canonicalizeLegacyResolvedModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  if (
    normalizeProviderId(params.provider) !== "openai-codex" ||
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
  model: Model<Api>;
}): Model<Api> | undefined {
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
  model: Model<Api>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> {
  const normalizeModelCost = (cost: unknown): Model<Api>["cost"] => {
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const record = cost as Partial<Model<Api>["cost"]>;
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
      return record as Model<Api>["cost"];
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
  } as Model<Api>;
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
  }) as Model<Api> | undefined;
  const compatNormalized = runtimeHooks.applyProviderResolvedModelCompatWithPlugins?.({
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
  }) as Model<Api> | undefined;
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
      model: (compatNormalized ?? pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model<Api> | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeHooks,
      model: compatNormalized ?? pluginNormalized ?? normalizedInputModel,
    });
  return canonicalizeLegacyResolvedModel({
    provider: params.provider,
    model: normalizeResolvedProviderModel({
      provider: params.provider,
      model:
        fallbackTransportNormalized ?? compatNormalized ?? pluginNormalized ?? normalizedInputModel,
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
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  return Math.floor(timeoutSeconds) * 1000;
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
  configuredParams?: unknown;
}): Record<string, unknown> | undefined {
  return mergeModelParams(
    readModelParams(params.discoveredParams),
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
    return {
      ...discoveredModel,
      ...(resolvedParams ? { params: resolvedParams } : {}),
      // Discovered models originate from models.json and may contain persistence markers.
      headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true }),
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
      headers: discoveredHeaders,
    };
  }
  const resolvedParams = mergeModelParams(
    readModelParams(discoveredModel.params),
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
    baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.runtimeHooks,
  });
  const resolvedContextWindow =
    metadataOverrideModel?.contextWindow ?? providerConfig.contextWindow;
  const resolvedMaxTokens =
    metadataOverrideModel?.maxTokens ?? providerConfig.maxTokens ?? discoveredModel.maxTokens;
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
        reasoning: metadataOverrideModel?.reasoning ?? discoveredModel.reasoning,
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
        compat: metadataOverrideModel?.compat ?? discoveredModel.compat,
      },
      providerRequest,
    ),
    providerConfig.localService,
  );
}
function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { kind: "resolved"; model: Model<Api> } | { kind: "suppressed" } | undefined {
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
    if (shouldUnconditionallySuppress({ provider, id: modelId, config: cfg })) {
      return { kind: "suppressed" };
    }
    const resolvedParams = mergeConfiguredRuntimeModelParams({
      cfg,
      provider,
      modelId,
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
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        } as Model<Api>,
        runtimeHooks,
      }),
    };
  }
  if (
    shouldSuppressBuiltInModel({
      provider,
      id: modelId,
      baseUrl: providerConfig?.baseUrl,
      config: cfg,
    })
  ) {
    return { kind: "suppressed" };
  }
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

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
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        } as Model<Api>,
        runtimeHooks,
      }),
    };
  }

  return undefined;
}

function resolvePluginDynamicModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
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
    },
  }) as Model<Api> | undefined;
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
}): Model<Api> | undefined {
  const { provider, modelId, cfg, agentDir, workspaceDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const requestTimeoutMs = resolveProviderRequestTimeoutMs(providerConfig?.timeoutSeconds);
  const configuredModel = findConfiguredProviderModel(providerConfig, provider, modelId);
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  const resolvedParams = mergeConfiguredRuntimeModelParams({
    cfg,
    provider,
    modelId,
    configuredParams: configuredModel?.params,
  });
  if (!providerConfig && !modelId.startsWith("mock-")) {
    return undefined;
  }
  const fallbackTransport = resolveProviderTransport({
    provider,
    api: resolveConfiguredProviderDefaultApi(providerConfig) ?? "openai-responses",
    baseUrl: providerConfig?.baseUrl,
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
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: attachModelProviderLocalService(
      attachModelProviderRequestTransport(
        {
          id: modelId,
          name: modelId,
          api: requestConfig.api ?? "openai-responses",
          provider,
          baseUrl: requestConfig.baseUrl,
          reasoning: configuredModel?.reasoning ?? false,
          input: resolveProviderModelInput({
            provider,
            modelId,
            modelName: configuredModel?.name ?? modelId,
            input: configuredModel?.input,
          }),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow:
            configuredModel?.contextWindow ??
            providerConfig?.contextWindow ??
            providerConfig?.models?.[0]?.contextWindow ??
            DEFAULT_CONTEXT_TOKENS,
          contextTokens:
            configuredModel?.contextTokens ??
            providerConfig?.contextTokens ??
            providerConfig?.models?.[0]?.contextTokens,
          maxTokens:
            configuredModel?.maxTokens ??
            providerConfig?.maxTokens ??
            providerConfig?.models?.[0]?.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          headers: requestConfig.headers,
        } as Model<Api>,
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

function preferProviderRuntimeResolvedModel(params: {
  explicitModel: Model<Api>;
  runtimeResolvedModel?: Model<Api>;
}): Model<Api> {
  if (params.runtimeResolvedModel) {
    return params.runtimeResolvedModel;
  }
  return params.explicitModel;
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const normalizedRef = {
    provider: params.provider,
    model: normalizeStaticProviderModelId(normalizeProviderId(params.provider), params.modelId),
  };
  const normalizedParams = {
    ...params,
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
  };
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const workspaceDir =
    normalizedParams.workspaceDir ?? normalizedParams.cfg?.agents?.defaults?.workspace;
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
  },
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const normalizedRef = {
    provider,
    model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
  };
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const workspaceDir = options?.workspaceDir ?? cfg?.agents?.defaults?.workspace;
  const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const model = resolveModelWithRegistry({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    workspaceDir,
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
    skipPiDiscovery?: boolean;
    workspaceDir?: string;
  },
): Promise<{
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}> {
  const normalizedRef = {
    provider,
    model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
  };
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const workspaceDir = options?.workspaceDir ?? cfg?.agents?.defaults?.workspace;
  const emptyDiscoveryStores =
    options?.skipPiDiscovery && (!options.authStorage || !options.modelRegistry)
      ? createEmptyPiDiscoveryStores()
      : undefined;
  const authStorage =
    options?.authStorage ??
    emptyDiscoveryStores?.authStorage ??
    discoverAuthStorage(resolvedAgentDir);
  const modelRegistry =
    options?.modelRegistry ??
    emptyDiscoveryStores?.modelRegistry ??
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
      },
    });
    return resolveModelWithRegistry({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      modelRegistry,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
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
      model = normalizeResolvedModel({
        provider: normalizedRef.provider,
        cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        model: staticCatalogModel,
        runtimeHooks,
      });
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
    config: params.cfg,
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
