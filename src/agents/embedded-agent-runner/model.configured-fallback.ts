import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { resolveCatalogOwnedModelCompat } from "../model-compat-catalog.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestRouteFacts,
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import { mergeModelMediaInput, resolveConfiguredFallbackReasoning } from "./model.compat.js";
import {
  clampModelMaxTokensToContextWindow,
  findConfiguredProviderModel,
  hasConfiguredFallbackSurface,
  mergeConfiguredRuntimeModelParams,
  resolveConfiguredProviderConfig,
  resolveConfiguredProviderDefaultApi,
  shouldSuppressConfiguredModel,
  type StaticCatalogFallbackModel,
} from "./model.configured-overrides.js";
import {
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import {
  normalizeResolvedModel,
  normalizeTransportBaseUrl,
  type ProviderRuntimeHooks,
  resolveProviderRequestTimeoutMs,
  resolveProviderTransport,
} from "./model.provider-hooks.js";
import type { ManifestModelCatalogProviderAliasMetadata } from "./model.static-catalog.js";

export function buildConfiguredFallbackModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
  getStaticCatalogModel?: () => StaticCatalogFallbackModel | undefined;
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
  const staticCatalogModel = params.getStaticCatalogModel?.();
  const metadataModel = configuredModel ?? staticCatalogModel;
  const fallbackMediaInput = mergeModelMediaInput(
    staticCatalogModel?.mediaInput,
    configuredModel?.mediaInput,
  );
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  const staticCatalogHeaders = sanitizeModelHeaders(staticCatalogModel?.headers, {
    stripSecretRefMarkers: true,
  });
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  const resolvedParams = mergeConfiguredRuntimeModelParams({
    cfg,
    provider,
    modelId,
    discoveredParams: staticCatalogModel?.params,
    providerParams: providerConfig?.params,
    configuredParams: configuredModel?.params,
  });
  const providerConfiguredApi = normalizeResolvedTransportApi(providerConfig?.api);
  const configuredModelBaseUrl = normalizeTransportBaseUrl(configuredModel?.baseUrl);
  const providerConfiguredBaseUrl = normalizeTransportBaseUrl(providerConfig?.baseUrl);
  const manifestAliasTransport = params.manifestAlias.transport;
  const manifestAliasBaseUrl = normalizeTransportBaseUrl(manifestAliasTransport?.baseUrl);
  const staticCatalogBaseUrl = normalizeTransportBaseUrl(staticCatalogModel?.baseUrl);
  const fallbackTransport = resolveProviderTransport({
    provider,
    modelId,
    api:
      normalizeResolvedTransportApi(configuredModel?.api) ??
      providerConfiguredApi ??
      manifestAliasTransport?.api ??
      normalizeResolvedTransportApi(staticCatalogModel?.api) ??
      resolveConfiguredProviderDefaultApi({
        provider,
        providerConfig,
        cfg,
        workspaceDir,
        runtimeHooks,
      }) ??
      "openai-responses",
    baseUrl:
      configuredModelBaseUrl ??
      providerConfiguredBaseUrl ??
      manifestAliasBaseUrl ??
      staticCatalogBaseUrl,
    cfg,
    workspaceDir,
    runtimeHooks,
  });
  const fallbackCompat = resolveCatalogOwnedModelCompat({
    ...(staticCatalogModel ? { catalogRoute: staticCatalogModel } : {}),
    catalogCompat: staticCatalogModel?.compat,
    configuredRoute: {
      api: fallbackTransport.api,
      baseUrl: fallbackTransport.baseUrl,
    },
    configuredCompat: configuredModel?.compat,
  });
  if (
    configuredModel &&
    shouldSuppressConfiguredModel({
      provider,
      modelId,
      cfg,
      workspaceDir,
      baseUrl: fallbackTransport.baseUrl,
    })
  ) {
    return undefined;
  }
  const requestConfig = resolveProviderRequestConfig({
    provider,
    api: fallbackTransport.api ?? "openai-responses",
    baseUrl: fallbackTransport.baseUrl,
    ...(params.providerMetadataOwners
      ? { providerMetadataOwners: params.providerMetadataOwners }
      : {}),
    discoveredHeaders: staticCatalogHeaders,
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
  const configuredFallbackMaxTokens =
    configuredModel?.maxTokens ??
    providerConfig?.maxTokens ??
    providerConfig?.models?.[0]?.maxTokens;
  const resolvedFallbackMaxTokens = configuredFallbackMaxTokens ?? staticCatalogModel?.maxTokens;
  const resolvedFallbackContextWindow =
    configuredModel?.contextWindow ?? staticCatalogModel?.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
  const normalizedResolvedFallbackMaxTokens = clampModelMaxTokensToContextWindow(
    resolvedFallbackMaxTokens,
    resolvedFallbackContextWindow,
  );
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: attachModelProviderRequestRouteFacts(
      attachModelProviderLocalService(
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
            ...(configuredModel?.thinkingLevelMap !== undefined
              ? { thinkingLevelMap: configuredModel.thinkingLevelMap }
              : {}),
            cost: metadataModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedFallbackContextWindow,
            contextTokens: configuredModel?.contextTokens ?? staticCatalogModel?.contextTokens,
            // maxTokens is a wire-level output cap, not a context-budget fallback.
            // Omit an unknown cap so strict providers can apply their own limit.
            ...(normalizedResolvedFallbackMaxTokens !== undefined
              ? {
                  maxTokens: normalizedResolvedFallbackMaxTokens,
                  maxTokensSource:
                    configuredFallbackMaxTokens !== undefined ? "configured" : "discovered",
                }
              : {}),
            ...(resolvedParams ? { params: resolvedParams } : {}),
            ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
            headers: requestConfig.headers,
            ...(providerConfig?.authHeader !== undefined
              ? { authHeader: providerConfig.authHeader }
              : {}),
            compat: fallbackCompat,
            mediaInput: fallbackMediaInput,
          } as Model,
          providerRequest,
        ),
        providerConfig?.localService,
      ),
      params.providerMetadataOwners,
    ),
    runtimeHooks,
  });
}
