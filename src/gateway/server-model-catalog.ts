// Gateway model catalog cache.
// Serves model catalogs with stale-while-refresh behavior for Gateway surfaces.
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadModelCatalogSnapshot = (params: {
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
}) => Promise<ModelCatalogSnapshot>;
type LoadGatewayModelCatalogParams = {
  getConfig?: () => GatewayModelCatalogConfig;
  loadModelCatalogSnapshot?: LoadModelCatalogSnapshot;
  readOnly?: boolean;
};

type GatewayModelCatalogCache = {
  lastSuccessfulCatalog: ModelCatalogSnapshot | null;
  inFlightRefresh: Promise<ModelCatalogSnapshot> | null;
  staleGeneration: number;
  appliedGeneration: number;
};

const loadModelCatalogModule = async () => await import("../agents/model-catalog.js");

function createGatewayModelCatalogCache(): GatewayModelCatalogCache {
  return {
    lastSuccessfulCatalog: null,
    inFlightRefresh: null,
    staleGeneration: 0,
    appliedGeneration: 0,
  };
}

const readOnlyModelCatalogCache = createGatewayModelCatalogCache();
const fullModelCatalogCache = createGatewayModelCatalogCache();

function resolveGatewayModelCatalogCache(
  params?: LoadGatewayModelCatalogParams,
): GatewayModelCatalogCache {
  return params?.readOnly === false ? fullModelCatalogCache : readOnlyModelCatalogCache;
}

function resetGatewayModelCatalogState(): void {
  for (const cache of [readOnlyModelCatalogCache, fullModelCatalogCache]) {
    cache.lastSuccessfulCatalog = null;
    cache.inFlightRefresh = null;
    cache.staleGeneration = 0;
    cache.appliedGeneration = 0;
  }
}

function isGatewayModelCatalogStale(cache: GatewayModelCatalogCache): boolean {
  return cache.appliedGeneration < cache.staleGeneration;
}

async function resolveLoadModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadModelCatalogSnapshot> {
  if (params?.loadModelCatalogSnapshot) {
    return params.loadModelCatalogSnapshot;
  }
  const { loadModelCatalogSnapshot } = await loadModelCatalogModule();
  return loadModelCatalogSnapshot;
}

function startGatewayModelCatalogRefresh(
  params?: LoadGatewayModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const cache = resolveGatewayModelCatalogCache(params);
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const readOnly = params?.readOnly !== false;
  const refreshGeneration = cache.staleGeneration;
  const refresh = resolveLoadModelCatalogSnapshot(params)
    .then((loadSnapshot) => loadSnapshot({ config, readOnly }))
    .then((snapshot) => {
      if (
        (readOnly || snapshot.entries.length > 0) &&
        refreshGeneration === cache.staleGeneration
      ) {
        cache.lastSuccessfulCatalog = snapshot;
        cache.appliedGeneration = cache.staleGeneration;
      }
      return snapshot;
    })
    .finally(() => {
      if (cache.inFlightRefresh === refresh) {
        cache.inFlightRefresh = null;
      }
    });
  cache.inFlightRefresh = refresh;
  return refresh;
}

/** Mark cached model catalogs stale after config/plugin reload changes. */
export function markGatewayModelCatalogStaleForReload(): void {
  readOnlyModelCatalogCache.staleGeneration += 1;
  fullModelCatalogCache.staleGeneration += 1;
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export async function resetModelCatalogCacheForTest(): Promise<void> {
  resetGatewayModelCatalogState();
  const { resetModelCatalogCacheForTest: resetModelCatalogCacheForTestLocal } =
    await loadModelCatalogModule();
  resetModelCatalogCacheForTestLocal();
}

/** Load the Gateway model catalog snapshot, returning cached data while stale refreshes run. */
export async function loadGatewayModelCatalogSnapshot(
  params?: LoadGatewayModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const cache = resolveGatewayModelCatalogCache(params);
  const isStale = isGatewayModelCatalogStale(cache);
  if (!isStale && cache.lastSuccessfulCatalog !== null) {
    return cache.lastSuccessfulCatalog;
  }
  if (isStale && cache.lastSuccessfulCatalog !== null) {
    if (!cache.inFlightRefresh) {
      void startGatewayModelCatalogRefresh(params).catch(() => undefined);
    }
    return cache.lastSuccessfulCatalog;
  }
  if (cache.inFlightRefresh) {
    return await cache.inFlightRefresh;
  }
  return await startGatewayModelCatalogRefresh(params);
}

/** Load the deduplicated Gateway model catalog for entries-only consumers. */
export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  return (await loadGatewayModelCatalogSnapshot(params)).entries;
}
