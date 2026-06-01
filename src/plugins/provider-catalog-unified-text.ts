import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import { readRecordValue } from "../shared/safe-record.js";
import {
  copyProviderCatalogModels,
  copyProviderCatalogResultEntries,
} from "./provider-catalog-result.js";
import type { ProviderCatalogResult } from "./types.js";

export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  // Runtime projection isolates unreadable catalog rows so one bad plugin-owned
  // provider/model entry cannot hide every healthy sibling from model selection.
  for (const [providerId, providerConfig] of copyProviderCatalogResultEntries(params)) {
    for (const model of copyProviderCatalogModels(providerConfig)) {
      const modelId = readRecordValue(model, "id");
      if (typeof modelId !== "string") {
        continue;
      }
      const modelName = readRecordValue(model, "name");
      rows.push({
        kind: "text",
        provider: providerId,
        model: modelId,
        ...(typeof modelName === "string" && modelName ? { label: modelName } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}
