import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ProviderCatalogResult } from "./types.js";

export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  if (!params.result) {
    return [];
  }
  const providers =
    "provider" in params.result
      ? { [params.providerId]: params.result.provider }
      : params.result.providers;
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    for (const model of providerConfig.models ?? []) {
      rows.push({
        kind: "text",
        provider: providerId,
        model: model.id,
        ...(model.name ? { label: model.name } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}
