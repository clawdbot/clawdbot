import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

/** Shared metadata projection; keep transport headers and authoring fields out of catalog entries. */
export function modelCatalogRowToEntry(row: NormalizedModelCatalogRow): ModelCatalogEntry {
  const contextWindow = row.contextWindow ?? row.contextTokens;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    api: row.api,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(row.contextWindows
      ? { contextWindows: row.contextWindows.map((option) => ({ ...option })) }
      : {}),
    ...(row.contextWindowDefault ? { contextWindowDefault: row.contextWindowDefault } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    reasoning: row.reasoning,
    ...(row.thinkingLevelMap ? { thinkingLevelMap: { ...row.thinkingLevelMap } } : {}),
    input: [...row.input],
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}
