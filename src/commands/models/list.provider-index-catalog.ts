import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadOpenClawProviderIndex,
  normalizeModelCatalogProviderId,
  planProviderIndexModelCatalogRows,
} from "../../model-catalog/index.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../../plugins/config-state.js";

export function loadProviderIndexCatalogRowsForList(params: {
  providerFilter: string;
  cfg: OpenClawConfig;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = normalizeModelCatalogProviderId(params.providerFilter);
  if (!providerFilter) {
    return [];
  }
  const index = loadOpenClawProviderIndex();
  return planProviderIndexModelCatalogRows({
    index,
    providerFilter,
  })
    .entries.filter(
      (entry) =>
        resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: "bundled",
          config: normalizePluginsConfig(params.cfg.plugins),
          rootConfig: params.cfg,
          enabledByDefault: true,
        }).enabled,
    )
    .flatMap((entry) => entry.rows);
}
