// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

export type ModelCatalogResult = {
  models: ModelCatalogEntry[];
  catalogMode?: "replace";
};

type ModelCatalogCacheEntry = {
  expiresAt: number;
  result: ModelCatalogResult;
  inFlight?: Promise<ModelCatalogResult>;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

type LoadModelsOptions = {
  agentId: string;
  preparedOnly?: boolean;
  refresh?: boolean;
  rejectOnFailure?: boolean;
  includeMetadata?: boolean;
};

export function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions & { includeMetadata: true },
): Promise<ModelCatalogResult>;
export function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogEntry[]>;
export async function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogEntry[] | ModelCatalogResult> {
  const result = await loadModelCatalogResult(client, opts);
  return opts.includeMetadata ? result : result.models;
}

async function loadModelCatalogResult(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogResult> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts.rejectOnFailure === true;
  const cacheKey = `${agentId}\0${opts.preparedOnly ? "prepared" : "exact"}`;
  const preparedCacheKey = `${agentId}\0prepared`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!opts.refresh && cached?.result && cached.expiresAt > now) {
    return cached.result;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!opts.refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight = requestModels(
    client,
    cached?.result,
    agentId,
    opts.preparedOnly === true,
    rejectOnFailure,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        const entry = {
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          result: result.result,
        };
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry from restoring stale data.
          cache.set(preparedCacheKey, entry);
        }
      }
      return result.result;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    result: cached?.result ?? { models: [] },
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(opts.refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogResult | undefined,
  agentId: string,
  preparedOnly: boolean,
  rejectOnFailure: boolean,
): Promise<{ result: ModelCatalogResult; fresh: boolean }> {
  try {
    const response = await client.request<ModelCatalogResult>("models.list", {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
    });
    const result: ModelCatalogResult = {
      models: response?.models ?? [],
      ...(response?.catalogMode === "replace" ? { catalogMode: "replace" as const } : {}),
    };
    return { result, fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { result: fallback ?? { models: [] }, fresh: false };
  }
}
