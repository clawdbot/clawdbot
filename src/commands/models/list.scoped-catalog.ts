import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
/** Dependency-light model catalog snapshots for default model-list views. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  loadManifestCatalogRowsForList,
  loadStaticManifestCatalogRowsForList,
} from "./list.manifest-catalog.js";

function toCatalogEntry(row: NormalizedModelCatalogRow): ModelCatalogEntry {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    api: row.api,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    reasoning: row.reasoning,
    input: [...row.input],
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}

function selectProviderRows(
  rows: readonly NormalizedModelCatalogRow[],
  providerIds: ReadonlySet<string>,
): NormalizedModelCatalogRow[] {
  return rows.filter((row) => providerIds.has(normalizeProviderId(row.provider)));
}

/** Builds an auth-scoped snapshot from manifest metadata already loaded by the command. */
export function loadScopedListModelCatalogSnapshot(params: {
  cfg: OpenClawConfig;
  providerIds: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogSnapshot {
  const providerIds = new Set(params.providerIds.map(normalizeProviderId).filter(Boolean));
  if (providerIds.size === 0) {
    return { entries: [], routeVariants: [], staticEntries: [] };
  }
  const loaderParams = {
    cfg: params.cfg,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  };
  const entries = selectProviderRows(loadManifestCatalogRowsForList(loaderParams), providerIds).map(
    toCatalogEntry,
  );
  const staticEntries = selectProviderRows(
    loadStaticManifestCatalogRowsForList(loaderParams),
    providerIds,
  ).map(toCatalogEntry);
  return {
    entries,
    routeVariants: [...entries],
    staticEntries,
  };
}
