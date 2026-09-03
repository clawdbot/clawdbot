/**
 * Loads model catalog views for browse/search UI surfaces.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

/** Visible model subset requested by model browse callers. */
export type ModelCatalogBrowseView = "default" | "configured" | "provider-config" | "all";

/** Source-authored provider rows for inventory UIs, independent of picker allowlists. */
export function buildProviderConfigModelCatalogForBrowse(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
}): ModelCatalogEntry[] {
  return buildConfiguredModelCatalog(params).toSorted(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
