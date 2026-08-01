import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Model } from "../../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveCatalogOwnedModelCompat } from "../model-compat-catalog.js";
import { modelKey, normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { shouldSuppressBuiltInModel, shouldUnconditionallySuppress } from "../model-suppression.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderMetadataOwners,
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import {
  mergeModelCompat,
  mergeModelMediaInput,
  resolveMergedConfiguredModelReasoning,
} from "./model.compat.js";
import {
  buildInlineProviderModels,
  type InlineModelEntry,
  type InlineProviderConfig,
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import {
  normalizeTransportBaseUrl,
  resolveProviderRequestTimeoutMs,
  resolveProviderTransport,
} from "./model.provider-hooks.js";
import {
  resolveBundledStaticCatalogModel,
  type ManifestModelCatalogProviderAliasMetadata,
} from "./model.static-catalog.js";

export type StaticCatalogFallbackModel = Model & {
  compat?: ModelCompatConfig;
  contextTokens?: number;
  params?: Record<string, unknown>;
  mediaInput?: ModelMediaInputConfig;
};

export function shouldSuppressConfiguredModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  baseUrl?: string;
}): boolean {
  if (
    shouldUnconditionallySuppress({
      provider: params.provider,
      id: params.modelId,
      ...(params.cfg ? { config: params.cfg } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    })
  ) {
    return true;
  }
  if (
    normalizeProviderId(params.provider) !== "openai" ||
    normalizeLowercaseStringOrEmpty(params.modelId) !== "gpt-5.3-codex-spark"
  ) {
    return false;
  }
  return shouldSuppressBuiltInModel({
    provider: params.provider,
    id: params.modelId,
    ...(params.cfg ? { config: params.cfg } : {}),
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

export function resolveConfiguredProviderDefaultApi(params: {
  provider: string;
  providerConfig: InlineProviderConfig | undefined;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Api | undefined {
  const { providerConfig } = params;
  const explicit = normalizeResolvedTransportApi(providerConfig?.api);
  if (explicit) {
    return explicit;
  }
  const providerConfiguredBaseUrl = normalizeTransportBaseUrl(providerConfig?.baseUrl);
  if (!providerConfiguredBaseUrl) {
    return undefined;
  }
  const normalized = resolveProviderTransport({
    provider: params.provider,
    api: undefined,
    baseUrl: providerConfiguredBaseUrl,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.runtimeHooks,
  });
  return normalized.api ?? "openai-completions";
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

export function findInlineModelMatch(params: {
  providers: Record<string, InlineProviderConfig>;
  preparedModels?: readonly InlineModelEntry[];
  provider: string;
  modelId: string;
}) {
  const matchesModelId = (entry: { provider: string; id?: string }) =>
    matchesProviderScopedModelId({
      candidateId: entry.id,
      provider: entry.provider,
      modelId: params.modelId,
    });
  const inlineModels = params.preparedModels ?? buildInlineProviderModels(params.providers);
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

export function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  const configuredProviders = cfg?.models?.providers;
  if (!configuredProviders) {
    return undefined;
  }
  return (
    configuredProviders[provider] ?? findNormalizedProviderValue(configuredProviders, provider)
  );
}

function isModelsAddMetadataModel(params: {
  model: NonNullable<InlineProviderConfig["models"]>[number] | undefined;
}) {
  return (
    (params.model as { metadataSource?: unknown } | undefined)?.metadataSource === "models-add"
  );
}

export function findConfiguredProviderModel(
  providerConfig: InlineProviderConfig | undefined,
  provider: string,
  modelId: string,
) {
  return providerConfig?.models?.find((candidate) =>
    matchesProviderScopedModelId({ candidateId: candidate.id, provider, modelId }),
  );
}

export function mergeStaticCatalogInlineModel(
  staticCatalogModel: StaticCatalogFallbackModel | undefined,
  inlineModel: Model,
): Model {
  if (!staticCatalogModel) {
    return inlineModel;
  }
  const compat = resolveCatalogOwnedModelCompat({
    catalogRoute: staticCatalogModel,
    catalogCompat: staticCatalogModel.compat,
    configuredRoute: inlineModel,
    configuredCompat: inlineModel.compat,
  });
  const mediaInput = mergeModelMediaInput(staticCatalogModel.mediaInput, inlineModel.mediaInput);
  const params = mergeModelParams(
    readModelParams(staticCatalogModel.params),
    readModelParams(inlineModel.params),
  );
  return {
    ...staticCatalogModel,
    ...inlineModel,
    api: inlineModel.api ?? staticCatalogModel.api,
    baseUrl:
      normalizeTransportBaseUrl(inlineModel.baseUrl) ??
      normalizeTransportBaseUrl(staticCatalogModel.baseUrl),
    headers: inlineModel.headers ?? staticCatalogModel.headers,
    ...(compat ? { compat } : {}),
    ...(mediaInput ? { mediaInput } : {}),
    ...(params ? { params } : {}),
  } as Model;
}

export function hasConfiguredFallbackSurface(params: {
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
  return Boolean(params.providerConfig?.baseUrl?.trim());
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

export function mergeConfiguredRuntimeModelParams(params: {
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

function markDiscoveredMaxTokensSource(model: ProviderRuntimeModel): ProviderRuntimeModel {
  if (model.maxTokens === undefined || model.maxTokensSource !== undefined) {
    return model;
  }
  return { ...model, maxTokensSource: "discovered" };
}

export function clampModelMaxTokensToContextWindow(
  maxTokens: number | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) {
    return undefined;
  }
  return typeof contextWindow === "number" && Number.isFinite(contextWindow)
    ? Math.min(maxTokens, contextWindow)
    : maxTokens;
}

export function applyConfiguredProviderOverrides(params: {
  provider: string;
  discoveredModel: ProviderRuntimeModel;
  providerConfig?: InlineProviderConfig;
  modelId: string;
  cfg?: OpenClawConfig;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
  runtimeHooks?: ProviderRuntimeHooks;
  preferDiscoveredModelMetadata?: boolean;
  preferDiscoveredTransport?: boolean;
  staticCatalogModel?: StaticCatalogFallbackModel;
  workspaceDir?: string;
}): ProviderRuntimeModel {
  const { providerConfig, modelId } = params;
  const discoveredModel = attachModelProviderMetadataOwners(
    markDiscoveredMaxTokensSource(params.discoveredModel),
    params.providerMetadataOwners,
  );
  const manifestAliasTransport = params.manifestAlias.transport;
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
    const aliasTransport = manifestAliasTransport
      ? resolveProviderTransport({
          provider: params.provider,
          modelId,
          api: manifestAliasTransport.api ?? discoveredModel.api,
          baseUrl:
            normalizeTransportBaseUrl(manifestAliasTransport.baseUrl) ?? discoveredModel.baseUrl,
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          runtimeHooks: params.runtimeHooks,
        })
      : undefined;
    const requestConfig = resolveProviderRequestConfig({
      provider: params.provider,
      api: aliasTransport?.api ?? discoveredModel.api,
      baseUrl: aliasTransport?.baseUrl ?? discoveredModel.baseUrl,
      ...(params.providerMetadataOwners
        ? { providerMetadataOwners: params.providerMetadataOwners }
        : {}),
      discoveredHeaders,
      capability: "llm",
      transport: "stream",
    });
    return {
      ...discoveredModel,
      ...(manifestAliasTransport
        ? {
            provider: params.provider,
            api: requestConfig.api ?? discoveredModel.api,
            baseUrl: requestConfig.baseUrl ?? discoveredModel.baseUrl,
          }
        : {}),
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
  const configuredStaticCatalogModel =
    configuredModel &&
    (params.staticCatalogModel ??
      (resolveBundledStaticCatalogModel({
        provider: params.provider,
        modelId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        includeRuntimeDiscovery: true,
      }) as StaticCatalogFallbackModel | undefined));
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
    ...(params.providerMetadataOwners
      ? { providerMetadataOwners: params.providerMetadataOwners }
      : {}),
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
    !providerConfig.localService &&
    !manifestAliasTransport
  ) {
    const resolvedParams = mergeModelParams(
      readModelParams(discoveredModel.params),
      defaultModelParams,
    );
    return {
      ...discoveredModel,
      ...(resolvedParams ? { params: resolvedParams } : {}),
      headers: passthroughRequestConfig.headers,
      ...(providerConfig.authHeader !== undefined ? { authHeader: providerConfig.authHeader } : {}),
    };
  }
  const resolvedParams = mergeModelParams(
    readModelParams(configuredStaticCatalogModel?.params),
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
  const providerDefaultApi = resolveConfiguredProviderDefaultApi({
    provider: params.provider,
    providerConfig,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.runtimeHooks,
  });
  const metadataOverrideBaseUrl = normalizeTransportBaseUrl(metadataOverrideModel?.baseUrl);
  const providerConfiguredBaseUrl = normalizeTransportBaseUrl(providerConfig.baseUrl);
  const discoveredBaseUrl = normalizeTransportBaseUrl(discoveredModel.baseUrl);
  const configuredStaticCatalogBaseUrl = normalizeTransportBaseUrl(
    configuredStaticCatalogModel?.baseUrl,
  );
  const manifestAliasBaseUrl = normalizeTransportBaseUrl(manifestAliasTransport?.baseUrl);
  // A retained alias owns transport identity and always takes the second branch
  // below. Discovery-first ordering is therefore alias-free by construction.
  const preferDiscoveredTransport = params.preferDiscoveredTransport && !manifestAliasTransport;
  const resolvedTransportApi = preferDiscoveredTransport
    ? (discoveredModel.api ??
      metadataOverrideModel?.api ??
      providerConfig.api ??
      configuredStaticCatalogModel?.api ??
      providerDefaultApi)
    : (metadataOverrideModel?.api ??
      providerConfig.api ??
      manifestAliasTransport?.api ??
      discoveredModel.api ??
      configuredStaticCatalogModel?.api ??
      providerDefaultApi);
  const resolvedTransportBaseUrl = preferDiscoveredTransport
    ? (discoveredBaseUrl ??
      metadataOverrideBaseUrl ??
      providerConfiguredBaseUrl ??
      configuredStaticCatalogBaseUrl)
    : (metadataOverrideBaseUrl ??
      providerConfiguredBaseUrl ??
      manifestAliasBaseUrl ??
      discoveredBaseUrl ??
      configuredStaticCatalogBaseUrl);

  const resolvedTransport = resolveProviderTransport({
    provider: params.provider,
    modelId: discoveredModel.id,
    api: resolvedTransportApi,
    baseUrl: resolvedTransportBaseUrl,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.runtimeHooks,
  });
  const resolvedContextWindow =
    metadataOverrideModel?.contextWindow ?? providerConfig.contextWindow;
  const configuredMaxTokens = metadataOverrideModel?.maxTokens ?? providerConfig.maxTokens;
  const resolvedMaxTokens = configuredMaxTokens ?? discoveredModel.maxTokens;
  const normalizedResolvedMaxTokens = clampModelMaxTokensToContextWindow(
    resolvedMaxTokens,
    resolvedContextWindow,
  );
  const catalogCompat = mergeModelCompat(
    configuredStaticCatalogModel?.compat,
    discoveredModel.compat,
  );
  const hasCatalogOwnedModel =
    configuredStaticCatalogModel !== undefined || discoveredModel.maxTokensSource !== "configured";
  const resolvedCompat = resolveCatalogOwnedModelCompat({
    ...(hasCatalogOwnedModel
      ? {
          catalogRoute: {
            api: discoveredModel.api ?? configuredStaticCatalogModel?.api,
            baseUrl: discoveredModel.baseUrl ?? configuredStaticCatalogModel?.baseUrl,
          },
        }
      : {}),
    catalogCompat,
    configuredRoute: {
      api: resolvedTransport.api,
      baseUrl: resolvedTransport.baseUrl,
    },
    configuredCompat: metadataOverrideModel?.compat,
  });
  const resolvedReasoning = resolveMergedConfiguredModelReasoning({
    provider: params.provider,
    configuredCompat: resolvedCompat,
    resolvedCompat,
    configuredReasoning: metadataOverrideModel?.reasoning,
    discoveredReasoning: discoveredModel.reasoning,
  });
  const requestConfig = resolveProviderRequestConfig({
    provider: params.provider,
    api:
      resolvedTransport.api ??
      normalizeResolvedTransportApi(configuredStaticCatalogModel?.api) ??
      normalizeResolvedTransportApi(discoveredModel.api) ??
      providerDefaultApi ??
      "openai-responses",
    baseUrl:
      resolvedTransport.baseUrl ?? configuredStaticCatalogModel?.baseUrl ?? discoveredModel.baseUrl,
    ...(params.providerMetadataOwners
      ? { providerMetadataOwners: params.providerMetadataOwners }
      : {}),
    discoveredHeaders,
    providerHeaders,
    modelHeaders: configuredHeaders,
    authHeader: providerConfig.authHeader,
    request: providerRequest,
    capability: "llm",
    transport: "stream",
  });
  return attachModelProviderMetadataOwners(
    attachModelProviderLocalService(
      attachModelProviderRequestTransport(
        {
          ...discoveredModel,
          provider: params.provider,
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
          ...(normalizedResolvedMaxTokens !== undefined
            ? {
                maxTokens: normalizedResolvedMaxTokens,
                maxTokensSource:
                  configuredMaxTokens !== undefined
                    ? "configured"
                    : (discoveredModel.maxTokensSource ?? "discovered"),
              }
            : {}),
          ...(resolvedParams ? { params: resolvedParams } : {}),
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          headers: requestConfig.headers,
          ...(providerConfig.authHeader !== undefined
            ? { authHeader: providerConfig.authHeader }
            : {}),
          compat: resolvedCompat,
          mediaInput: mergeModelMediaInput(
            mergeModelMediaInput(
              configuredStaticCatalogModel?.mediaInput,
              discoveredModel.mediaInput,
            ),
            metadataOverrideModel?.mediaInput,
          ),
        },
        providerRequest,
      ),
      providerConfig.localService,
    ),
    params.providerMetadataOwners,
  );
}
