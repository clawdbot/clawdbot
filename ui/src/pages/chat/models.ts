// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
// A picker open is an operator signal to revalidate, but full provider discovery can be slow.
const MODEL_CATALOG_REFRESH_COOLDOWN_MS = 5 * 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  refreshEligibleAt?: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
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

export async function loadModels(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    preparedOnly?: boolean;
    refresh?: boolean;
    refreshIfDue?: boolean;
    rejectOnFailure?: boolean;
  },
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts?.rejectOnFailure === true;
  const cacheKey = `${agentId}\0${opts.preparedOnly ? "prepared" : "exact"}`;
  const preparedCacheKey = `${agentId}\0prepared`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  const refresh =
    opts.refresh === true ||
    (opts.refreshIfDue === true && (cached?.refreshEligibleAt ?? 0) <= now);
  const nextRefreshEligibleAt = refresh
    ? now + MODEL_CATALOG_REFRESH_COOLDOWN_MS
    : cached?.refreshEligibleAt;
  const refreshCooldownActive =
    opts.refreshIfDue === true && (cached?.refreshEligibleAt ?? 0) > now;
  if (
    opts.refreshIfDue === true &&
    cached?.inFlight &&
    cached.inFlightRefresh === true &&
    cached.inFlightRejects === rejectOnFailure
  ) {
    return cached.inFlight;
  }
  if (!refresh && cached?.models && (cached.expiresAt > now || refreshCooldownActive)) {
    return cached.models;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(
    client,
    cached?.models,
    agentId,
    opts.preparedOnly === true,
    refresh,
    rejectOnFailure,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        const refreshEligibleAt = refresh
          ? result.fresh
            ? Date.now() + MODEL_CATALOG_REFRESH_COOLDOWN_MS
            : undefined
          : nextRefreshEligibleAt;
        const entry = {
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          ...(refreshEligibleAt ? { refreshEligibleAt } : {}),
          models: result.models,
        };
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry from restoring stale data.
          cache.set(preparedCacheKey, entry);
        }
      }
      return result.models;
    })
    .catch((error: unknown) => {
      const latest = cache.get(cacheKey);
      if (refresh && latest?.inFlight === inFlight) {
        delete latest.refreshEligibleAt;
      }
      throw error;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    ...(nextRefreshEligibleAt ? { refreshEligibleAt: nextRefreshEligibleAt } : {}),
    models: cached?.models ?? [],
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
  agentId: string,
  preparedOnly: boolean,
  refresh: boolean,
  rejectOnFailure: boolean,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
    return { models: result?.models ?? [], fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}
