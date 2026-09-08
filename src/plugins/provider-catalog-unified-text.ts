/** Builds unified text-inference provider catalog metadata from plugin providers. */
import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import { copyProviderCatalogResultEntries } from "./provider-catalog-result.js";
import type { ProviderCatalogResult } from "./types.js";

/** Projects plugin provider catalog results into unified text-model catalog rows. */
export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  // The result copier isolates unreadable plugin rows and owns these model records;
  // consume their validated ids and names without copying the catalog again.
  for (const [providerId, providerConfig] of copyProviderCatalogResultEntries(params)) {
    for (const model of providerConfig.models) {
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
