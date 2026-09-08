import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPlugin,
} from "../plugins/types.js";
import {
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  liveModelCatalogAuthCacheKey,
  type FetchLiveProviderModelIdsParams,
  type FetchLiveProviderModelRowsParams,
  type LiveModelCatalogFetchGuard,
  type LiveModelRowProjection,
} from "./provider-catalog-live-acquisition.internal.js";
import { buildOpenAICompatibleLiveModels } from "./provider-catalog-live-normalize.internal.js";
import {
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "./provider-catalog-live-outcome.internal.js";
import {
  buildSingleProviderApiKeyCatalog,
  getCachedLiveCatalogValue,
  type ManifestProviderCatalogEntry,
} from "./provider-catalog-shared.js";
import {
  normalizeProviderId,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
} from "./provider-model-shared.js";

export { LiveModelCatalogHttpError, runLiveProviderCatalog };
export { fetchLiveProviderModelIds, getCachedLiveProviderModelRows };
export {
  fetchLiveProviderModelRows,
  getCachedUpstreamProviderCatalog,
} from "./provider-catalog-live-acquisition.internal.js";
export type {
  CachedLiveProviderModelRowsParams,
  FetchLiveProviderModelIdsParams,
  FetchLiveProviderModelRowsParams,
  GetCachedUpstreamProviderCatalogParams,
  LiveModelCatalogFetchGuard,
  LiveModelCatalogHeaderContext,
  LiveModelRowProjection,
} from "./provider-catalog-live-acquisition.internal.js";
export { clearLiveCatalogCacheForTests } from "./provider-catalog-shared.js";
export {
  readLiveModelCatalogBooleanField,
  readLiveModelCatalogPositiveSafeIntegerField,
  readLiveModelCatalogStringField,
} from "./provider-catalog-live-normalize.internal.js";
export {
  listProviderCatalogSnapshotEntries,
  projectProviderCatalogSnapshotRows,
  projectUpstreamProviderCatalogSnapshot,
  type ProviderCatalogSnapshot,
} from "./provider-catalog-snapshot.internal.js";
export type {
  ProjectedUpstreamProviderCatalogModel,
  UpstreamProviderCatalog,
  UpstreamProviderCatalogModel,
} from "./provider-catalog-live-normalize.internal.js";

export type BuildLiveModelProviderConfigParams<T extends ModelDefinitionConfig> =
  FetchLiveProviderModelIdsParams & {
    discoveryMode?: "strict";
    providerConfig: Omit<ModelProviderConfig, "models">;
    models: readonly T[];
    ttlMs?: number;
    cacheKeyParts?: readonly unknown[];
    /** Provider-owned projection for catalogs that publish richer metadata than model ids. */
    projectRows?: LiveModelRowProjection<T>;
    /** Retry a rejected authenticated catalog request against the provider's public catalog. */
    fallbackToAnonymousOnUnauthorized?: boolean;
  };

export type OpenAICompatibleModelDiscoveryOptions = {
  authentication?: "none";
  /** Fixed endpoint used only while the effective inference base remains canonical. */
  endpointUrl?: {
    url: string;
    requireBaseUrl: string;
  };
  /** Relative path appended to the effective provider base URL. Defaults to `models`. */
  endpointPath?: string;
  /** Provider-specific response row selector when the response is not `{ data: [] }`. */
  readRows?: FetchLiveProviderModelRowsParams["readRows"];
  /** Provider-owned projection when the conservative OpenAI-compatible projection is insufficient. */
  projectRows?: LiveModelRowProjection;
  /** Live catalog request timeout. Defaults to 5 seconds. */
  timeoutMs?: number;
  /** Successful live catalog cache lifetime. Defaults to 60 seconds. */
  ttlMs?: number;
  /** Provider-specific authorization headers for non-Bearer model-list APIs. */
  buildRequestHeaders?: FetchLiveProviderModelRowsParams["buildRequestHeaders"];
  /**
   * Gate for discovered ids the manifest does not already publish. Providers
   * whose request shaping is model-version specific use this to drop models
   * they cannot yet shape, so discovery never surfaces a selectable model that
   * would build an invalid request. Manifest-published ids bypass it.
   */
  acceptUnknownModel?: (params: { id: string; record: Record<string, unknown> }) => boolean;
};

export type BuildOpenAICompatibleProviderCatalogParams = {
  ctx: ProviderCatalogContext;
  providerId: string;
  providerAliases?: readonly string[];
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
  modelDiscovery?: OpenAICompatibleModelDiscoveryOptions;
  discoveryMode?: "strict";
};

function matchesProviderCatalogScope(
  ctx: Pick<ProviderCatalogContext, "providerIds">,
  providerIds: readonly string[],
): boolean {
  const selected = ctx.providerIds;
  return (
    selected === undefined || providerIds.some((id) => selected.includes(normalizeProviderId(id)))
  );
}

function buildProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
  models: readonly T[],
): ModelProviderConfig {
  return {
    ...params.providerConfig,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: [...models],
  };
}

async function projectCachedLiveModelRows<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T> & {
    fallback: ModelProviderConfig;
    projectRows: LiveModelRowProjection<T>;
  },
): Promise<readonly T[]> {
  const load = async (requestAuth: { apiKey?: string; discoveryApiKey?: string }) => {
    const rows = await getCachedLiveProviderModelRows({
      ...params,
      ...requestAuth,
      cacheKeyParts:
        requestAuth.apiKey === params.apiKey &&
        requestAuth.discoveryApiKey === params.discoveryApiKey
          ? params.cacheKeyParts
          : undefined,
      shouldCacheRows: (candidateRows) =>
        params.projectRows(candidateRows, params.fallback).length > 0,
    });
    return params.projectRows(rows, params.fallback);
  };

  try {
    return await load({ apiKey: params.apiKey, discoveryApiKey: params.discoveryApiKey });
  } catch (error) {
    if (
      params.fallbackToAnonymousOnUnauthorized &&
      params.discoveryMode !== "strict" &&
      error instanceof LiveModelCatalogHttpError &&
      error.status === 401 &&
      (params.apiKey || params.discoveryApiKey)
    ) {
      return await load({ apiKey: undefined, discoveryApiKey: undefined });
    }
    throw error;
  }
}

export async function buildLiveModelProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
): Promise<ModelProviderConfig> {
  const fallback = buildProviderConfig(params, params.models);
  try {
    if (params.projectRows) {
      const models = await projectCachedLiveModelRows({
        ...params,
        fallback,
        projectRows: params.projectRows,
      });
      if (models.length > 0 || params.discoveryMode === "strict") {
        return { ...fallback, models: [...models] };
      }
      return fallback;
    }
    const liveModelIds = await getCachedLiveCatalogValue({
      keyParts: params.cacheKeyParts ?? [
        params.providerId,
        "models",
        params.endpoint,
        liveModelCatalogAuthCacheKey(params),
      ],
      ttlMs: params.ttlMs,
      load: async () => await fetchLiveProviderModelIds(params),
      shouldCache: (modelIds) => modelIds.length > 0,
    });
    const liveModelIdSet = new Set(liveModelIds);
    const models = params.models.filter((model) => liveModelIdSet.has(model.id));
    if (models.length > 0 || params.discoveryMode === "strict") {
      return buildProviderConfig(params, models);
    }
  } catch (error) {
    if (params.discoveryMode === "strict") {
      throw error;
    }
    // Live model catalogs are advisory. Keep provider-owned static rows visible
    // when discovery is unavailable or the provider returns an unexpected body.
  }
  return fallback;
}

function resolveLiveModelDiscoveryEndpoint(baseUrl: string, endpointPath: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = endpointPath.trim().replace(/^\/+/, "");
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function resolveFixedLiveModelDiscoveryEndpoint(
  baseUrl: string,
  endpoint: NonNullable<OpenAICompatibleModelDiscoveryOptions["endpointUrl"]>,
): string | undefined {
  const effectiveBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const requiredBaseUrl = endpoint.requireBaseUrl.trim().replace(/\/+$/, "");
  return effectiveBaseUrl === requiredBaseUrl ? endpoint.url : undefined;
}

type OpenAICompatibleLiveModelProviderParams = {
  providerId: string;
  providerConfig: ModelProviderConfig;
  apiKey?: string;
  discoveryApiKey?: string;
  profileId?: string;
  modelDiscovery?: OpenAICompatibleModelDiscoveryOptions;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  discoveryMode?: "strict";
};

function prepareOpenAICompatibleLiveModelDiscovery(
  params: OpenAICompatibleLiveModelProviderParams,
) {
  const fallback = {
    ...params.providerConfig,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };
  const acceptUnknownModel = params.modelDiscovery?.acceptUnknownModel;
  const endpoint = params.modelDiscovery?.endpointUrl
    ? resolveFixedLiveModelDiscoveryEndpoint(fallback.baseUrl, params.modelDiscovery.endpointUrl)
    : resolveLiveModelDiscoveryEndpoint(
        fallback.baseUrl,
        params.modelDiscovery?.endpointPath ?? "models",
      );
  if (!endpoint) {
    return { kind: "static" as const, provider: fallback };
  }
  const { models, ...providerConfig } = fallback;
  const auth =
    params.modelDiscovery?.authentication === "none"
      ? {}
      : {
          apiKey: params.apiKey,
          discoveryApiKey: params.discoveryApiKey,
          profileId: params.profileId,
        };
  const request: BuildLiveModelProviderConfigParams<ModelDefinitionConfig> = {
    discoveryMode: params.discoveryMode,
    providerId: params.providerId,
    endpoint,
    providerConfig,
    models,
    apiKey: auth.apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: params.modelDiscovery?.timeoutMs,
    ttlMs: params.modelDiscovery?.ttlMs ?? 60_000,
    auditContext: `${params.providerId}-model-discovery`,
    readRows: params.modelDiscovery?.readRows,
    buildRequestHeaders: params.modelDiscovery?.buildRequestHeaders,
    projectRows:
      params.modelDiscovery?.projectRows ??
      ((rows, fallbackProvider) =>
        buildOpenAICompatibleLiveModels(rows, fallbackProvider, acceptUnknownModel)),
  };
  return { kind: "live" as const, request, profileId: auth.profileId };
}

export async function buildOpenAICompatibleLiveModelProviderConfig(
  params: OpenAICompatibleLiveModelProviderParams,
): Promise<ModelProviderConfig> {
  const discovery = prepareOpenAICompatibleLiveModelDiscovery(params);
  return discovery.kind === "static"
    ? discovery.provider
    : await buildLiveModelProviderConfig(discovery.request);
}

export async function buildOpenAICompatibleLiveProviderCatalog(
  params: OpenAICompatibleLiveModelProviderParams,
): Promise<ProviderCatalogResult> {
  const discovery = prepareOpenAICompatibleLiveModelDiscovery(params);
  if (discovery.kind === "static") {
    return { provider: discovery.provider };
  }
  const run = async () => ({
    provider: await buildLiveModelProviderConfig(discovery.request),
  });
  return params.discoveryMode === "strict"
    ? await runLiveProviderCatalog({
        providerId: params.providerId,
        profileId: discovery.profileId,
        run,
      })
    : await run();
}

/** Builds the shared authenticated live/static hooks for an ordered provider family. */
export function buildOpenAICompatibleProviderFamilyCatalog(params: {
  credentialProviderId: string;
  entries: readonly ManifestProviderCatalogEntry[];
  staticCatalog: () => Promise<{ providers: Record<string, ModelProviderConfig> }>;
  augmentModelCatalog: NonNullable<ProviderPlugin["augmentModelCatalog"]>;
  discoveryMode?: "strict";
}) {
  return {
    catalog: {
      order: "paired" as const,
      run: async (ctx: ProviderCatalogContext) => {
        const entries = params.entries.filter(({ id }) => matchesProviderCatalogScope(ctx, [id]));
        if (entries.length === 0) {
          return null;
        }
        const auth = ctx.resolveProviderApiKey(params.credentialProviderId);
        if (!auth.apiKey) {
          return null;
        }
        const results = await Promise.all(
          entries.map(async ({ id, buildProvider }) => ({
            id,
            result: await buildOpenAICompatibleLiveProviderCatalog({
              providerId: id,
              providerConfig: buildProvider(),
              apiKey: auth.apiKey,
              discoveryApiKey: auth.discoveryApiKey,
              profileId: auth.profileId,
              discoveryMode: params.discoveryMode,
            }),
          })),
        );
        return {
          providers: Object.fromEntries(
            results.flatMap(({ id, result }) =>
              result && "provider" in result ? [[id, result.provider]] : [],
            ),
          ),
          ...(params.discoveryMode === "strict"
            ? { outcomes: results.flatMap(({ result }) => result?.outcomes ?? []) }
            : {}),
        };
      },
      staticRun: params.staticCatalog,
    },
    augmentModelCatalog: params.augmentModelCatalog,
  };
}

export async function buildOpenAICompatibleProviderCatalog(
  params: BuildOpenAICompatibleProviderCatalogParams,
): Promise<ProviderCatalogResult> {
  if (
    !matchesProviderCatalogScope(params.ctx, [params.providerId, ...(params.providerAliases ?? [])])
  ) {
    return null;
  }
  const auth = params.ctx.resolveProviderApiKey(normalizeProviderId(params.providerId));
  const result = await buildSingleProviderApiKeyCatalog({
    ctx: { ...params.ctx, resolveProviderApiKey: () => auth },
    providerId: params.providerId,
    buildProvider: params.buildProvider,
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
  });
  if (!result || !("provider" in result)) {
    return result;
  }
  return await buildOpenAICompatibleLiveProviderCatalog({
    providerId: params.providerId,
    providerConfig: result.provider,
    apiKey: auth.apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    modelDiscovery: params.modelDiscovery,
    profileId: auth.profileId,
    discoveryMode: params.discoveryMode,
  });
}
