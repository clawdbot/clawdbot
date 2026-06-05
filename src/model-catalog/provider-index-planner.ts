// Provider-index model-catalog planner converts installable provider previews into normalized discovery rows.
import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalogProvider,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawProviderIndex } from "./provider-index/index.js";

// Provider-index planner converts ClawHub-style preview catalog entries into
// normalized model rows for discovery before a plugin is installed.
type ProviderIndexModelCatalogPlanEntry = {
  provider: string;
  pluginId: string;
  rows: readonly NormalizedModelCatalogRow[];
};

type ProviderIndexModelCatalogPlan = {
  rows: readonly NormalizedModelCatalogRow[];
  entries: readonly ProviderIndexModelCatalogPlanEntry[];
};

function withPreviewStatusDefaults(providerCatalog: ModelCatalogProvider): ModelCatalogProvider {
  // Provider-index rows are advisory discovery data, so unspecified model
  // statuses default to preview instead of stable.
  return {
    ...providerCatalog,
    models: providerCatalog.models.map((model) => ({
      ...model,
      status: model.status ?? "preview",
    })),
  };
}

export function planProviderIndexModelCatalogRows(params: {
  index: OpenClawProviderIndex;
  providerFilter?: string;
}): ProviderIndexModelCatalogPlan {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const entries: ProviderIndexModelCatalogPlanEntry[] = [];

  for (const [providerId, provider] of Object.entries(params.index.providers)) {
    const normalizedProvider = normalizeModelCatalogProviderId(providerId);
    if (
      !normalizedProvider ||
      (providerFilter && normalizedProvider !== providerFilter) ||
      !provider.previewCatalog
    ) {
      continue;
    }
    const rows = normalizeModelCatalogProviderRows({
      provider: normalizedProvider,
      providerCatalog: withPreviewStatusDefaults(provider.previewCatalog),
      source: "provider-index",
    });
    if (rows.length === 0) {
      continue;
    }
    entries.push({
      provider: normalizedProvider,
      pluginId: provider.plugin.id,
      rows,
    });
  }

  return {
    entries,
    rows: entries
      .flatMap((entry) => entry.rows)
      .toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
      ),
  };
}
