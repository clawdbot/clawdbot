import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadModelCatalog = (params: {
  config: GatewayModelCatalogConfig;
}) => Promise<GatewayModelChoice[]>;
type LoadGatewayModelCatalogParams = {
  getConfig?: () => GatewayModelCatalogConfig;
  loadModelCatalog?: LoadModelCatalog;
};

let lastSuccessfulCatalog: GatewayModelChoice[] | null = null;
let inFlightRefresh: Promise<GatewayModelChoice[]> | null = null;
let staleGeneration = 0;
let appliedGeneration = 0;

function resetGatewayModelCatalogState(): void {
  lastSuccessfulCatalog = null;
  inFlightRefresh = null;
  staleGeneration = 0;
  appliedGeneration = 0;
}

function isGatewayModelCatalogStale(): boolean {
  return appliedGeneration < staleGeneration;
}

async function resolveLoadModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadModelCatalog> {
  if (params?.loadModelCatalog) {
    return params.loadModelCatalog;
  }
  const { loadModelCatalog } = await import("../agents/model-catalog.js");
  return loadModelCatalog;
}

function startGatewayModelCatalogRefresh(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const refreshGeneration = staleGeneration;
  const refresh = resolveLoadModelCatalog(params)
    .then((loadModelCatalog) => loadModelCatalog({ config }))
    .then((catalog) => {
      if (catalog.length > 0 && refreshGeneration === staleGeneration) {
        lastSuccessfulCatalog = catalog;
        appliedGeneration = staleGeneration;
      }
      return catalog;
    })
    .finally(() => {
      if (inFlightRefresh === refresh) {
        inFlightRefresh = null;
      }
    });
  inFlightRefresh = refresh;
  return refresh;
}

export function markGatewayModelCatalogStaleForReload(): void {
  staleGeneration += 1;
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export async function __resetModelCatalogCacheForTest(): Promise<void> {
  resetGatewayModelCatalogState();
  const { resetModelCatalogCacheForTest } = await import("../agents/model-catalog.js");
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const isStale = isGatewayModelCatalogStale();
  if (!isStale && lastSuccessfulCatalog) {
    return lastSuccessfulCatalog;
  }
  if (isStale && lastSuccessfulCatalog) {
    if (!inFlightRefresh) {
      void startGatewayModelCatalogRefresh(params).catch(() => undefined);
    }
    return lastSuccessfulCatalog;
  }
  if (inFlightRefresh) {
    return await inFlightRefresh;
  }
  return await startGatewayModelCatalogRefresh(params);
}
