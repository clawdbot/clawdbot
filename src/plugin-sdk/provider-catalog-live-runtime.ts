import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "./ssrf-runtime.js";

export type LiveModelCatalogFetchGuard = typeof fetchWithSsrFGuard;

export type LiveModelCatalogHeaderContext = {
  apiKey?: string;
  discoveryApiKey?: string;
};

export { clearLiveCatalogCacheForTests };

export type FetchLiveProviderModelIdsParams = {
  providerId: string;
  endpoint: string;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditContext?: string;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  requireHttps?: boolean;
  readRows?: (body: unknown) => readonly unknown[];
  readModelId?: (row: unknown) => string | undefined;
  buildRequestHeaders?: (ctx: LiveModelCatalogHeaderContext) => HeadersInit;
};

export type FetchLiveProviderModelRowsParams = Omit<FetchLiveProviderModelIdsParams, "readModelId">;

export type CachedLiveProviderModelRowsParams = FetchLiveProviderModelRowsParams & {
  ttlMs?: number;
  cacheKeyParts?: readonly unknown[];
  shouldCacheRows?: (rows: readonly unknown[]) => boolean;
};

export class LiveModelCatalogHttpError extends Error {
  readonly status: number;

  constructor(providerId: string, status: number) {
    super(`${providerId} model discovery failed: HTTP ${status}`);
    this.name = "LiveModelCatalogHttpError";
    this.status = status;
  }
}

export type BuildLiveModelProviderConfigParams<T extends ModelDefinitionConfig> =
  FetchLiveProviderModelIdsParams & {
    providerConfig: Omit<ModelProviderConfig, "models">;
    models: readonly T[];
    ttlMs?: number;
    cacheKeyParts?: readonly unknown[];
  };

function readDefaultLiveModelCatalogRows(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  throw new Error("Live model catalog response must be an array or { data: [] }");
}

function readDefaultLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim();
  return modelId || undefined;
}

function normalizeLiveModelCatalogRequestApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function selectLiveModelCatalogRequestApiKey(
  ctx: LiveModelCatalogHeaderContext,
): string | undefined {
  return (
    normalizeLiveModelCatalogRequestApiKey(ctx.discoveryApiKey) ??
    normalizeLiveModelCatalogRequestApiKey(ctx.apiKey)
  );
}

function buildDefaultLiveModelCatalogHeaders(ctx: LiveModelCatalogHeaderContext): HeadersInit {
  const requestApiKey = selectLiveModelCatalogRequestApiKey(ctx);
  return {
    Accept: "application/json",
    ...(requestApiKey ? { Authorization: `Bearer ${requestApiKey}` } : {}),
  };
}

function buildHeaders(params: FetchLiveProviderModelIdsParams): Headers {
  const requestApiKey = selectLiveModelCatalogRequestApiKey(params);
  const headers = new Headers(
    (params.buildRequestHeaders ?? buildDefaultLiveModelCatalogHeaders)({
      apiKey: normalizeLiveModelCatalogRequestApiKey(params.apiKey),
      discoveryApiKey: requestApiKey,
    }),
  );
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  return headers;
}

export async function fetchLiveProviderModelRows(
  params: FetchLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  const fetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
  const { response, release } = await fetchGuard({
    url: params.endpoint,
    init: {
      headers: buildHeaders(params),
    },
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? 5_000,
    policy: params.policy ?? ssrfPolicyFromHttpBaseUrlAllowedHostname(params.endpoint),
    ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
    ...(params.requireHttps !== undefined ? { requireHttps: params.requireHttps } : {}),
    auditContext: params.auditContext ?? `${params.providerId}-model-discovery`,
  });
  try {
    if (!response.ok) {
      throw new LiveModelCatalogHttpError(params.providerId, response.status);
    }
    return (params.readRows ?? readDefaultLiveModelCatalogRows)(await response.json());
  } finally {
    await release();
  }
}

function liveModelCatalogAuthCacheKey(params: LiveModelCatalogHeaderContext): string | undefined {
  return selectLiveModelCatalogRequestApiKey(params);
}

export async function getCachedLiveProviderModelRows(
  params: CachedLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  return await getCachedLiveCatalogValue({
    keyParts: params.cacheKeyParts ?? [
      params.providerId,
      "model-rows",
      params.endpoint,
      liveModelCatalogAuthCacheKey(params),
    ],
    ttlMs: params.ttlMs,
    load: async () => await fetchLiveProviderModelRows(params),
    shouldCache: params.shouldCacheRows,
  });
}

export async function fetchLiveProviderModelIds(
  params: FetchLiveProviderModelIdsParams,
): Promise<string[]> {
  const rows = await fetchLiveProviderModelRows(params);
  const readModelId = params.readModelId ?? readDefaultLiveModelId;
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const row of rows) {
    const modelId = readModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
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

export async function buildLiveModelProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
): Promise<ModelProviderConfig> {
  try {
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
    if (models.length > 0) {
      return buildProviderConfig(params, models);
    }
  } catch {
    // Live model catalogs are advisory. Keep provider-owned static rows visible
    // when discovery is unavailable or the provider returns an unexpected body.
  }
  return buildProviderConfig(params, params.models);
}
