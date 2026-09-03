import {
  MODEL_CATALOG_APIS,
  type ModelCatalogApi,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

export type ModelCatalogSourceRow = {
  id: string;
  name?: string;
  provider: string;
  api?: string | null;
  baseUrl?: string;
  contextWindow?: number;
  contextWindows?: readonly NonNullable<ModelCatalogEntry["contextWindows"]>[number][];
  contextWindowDefault?: string;
  contextTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ModelCatalogEntry["thinkingLevelMap"];
  input?: readonly NonNullable<ModelCatalogEntry["input"]>[number][];
  compat?: ModelCatalogEntry["compat"];
  mediaInput?: ModelCatalogEntry["mediaInput"];
  params?: ModelCatalogEntry["params"];
  status?: ModelCatalogEntry["status"];
  statusReason?: string;
  replaces?: readonly string[];
  replacedBy?: string;
};

// Runtime models carry a free-form transport api; only catalog-core's closed set becomes a route fact.
const CATALOG_MODEL_APIS: ReadonlySet<string> = new Set(MODEL_CATALOG_APIS);

function isCatalogModelApi(value: string): value is ModelCatalogApi {
  return CATALOG_MODEL_APIS.has(value);
}

/** Shared metadata projection; keep transport headers and authoring fields out of catalog entries. */
export function modelCatalogRowToEntry(row: ModelCatalogSourceRow): ModelCatalogEntry {
  const contextWindow = row.contextWindow ?? row.contextTokens;
  return {
    id: row.id,
    name: row.name ?? row.id,
    provider: row.provider,
    ...(row.api && isCatalogModelApi(row.api) ? { api: row.api } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(row.contextWindows
      ? { contextWindows: row.contextWindows.map((option) => ({ ...option })) }
      : {}),
    ...(row.contextWindowDefault ? { contextWindowDefault: row.contextWindowDefault } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
    ...(row.thinkingLevelMap ? { thinkingLevelMap: { ...row.thinkingLevelMap } } : {}),
    ...(row.input ? { input: [...row.input] } : {}),
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}
