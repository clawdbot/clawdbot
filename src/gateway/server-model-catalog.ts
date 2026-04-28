import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export async function __resetModelCatalogCacheForTest(): Promise<void> {
  const { resetModelCatalogCacheForTest } = await import("../agents/model-catalog.js");
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  const { loadModelCatalog } = await import("../agents/model-catalog.js");
  return await loadModelCatalog({ config: (params?.getConfig ?? getRuntimeConfig)() });
}
