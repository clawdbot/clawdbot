/** Projects the prepared model generation together with configured model rows. */
import type { ModelRegistry } from "../../llm/model-registry.js";
import {
  appendAuthenticatedCatalogRows,
  appendConfiguredProviderRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  appendPreparedModelCatalogRows,
  loadListModelCatalogSnapshot,
  type RowBuilderContext,
} from "./list.rows.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type AllModelRowSources = {
  rows: ModelRow[];
  entries?: ConfiguredEntry[];
  context: RowBuilderContext;
  modelRegistry?: ModelRegistry;
  registryModels?: ReturnType<ModelRegistry["getAll"]>;
};

/** Appends all rows requested by `models list --all` or a provider-filtered list. */
export async function appendAllModelRowSources(params: AllModelRowSources): Promise<void> {
  const seenKeys = await appendDiscoveredRows({
    rows: params.rows,
    models: params.registryModels ?? params.modelRegistry?.getAll() ?? [],
    modelRegistry: params.modelRegistry,
    context: params.context,
    resolveWithRegistry: Boolean(params.context.filter.provider),
    skipSuppression: Boolean(params.modelRegistry),
  });

  // Registry rows win when already discovered; every remaining catalog row and
  // route variant must come from the single committed lifecycle generation.
  await appendPreparedModelCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  // Authored provider definitions are authoritative for configured metadata;
  // only synthesize missing configured references after real rows were tried.
  await appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  if (params.context.filter.provider && params.entries && params.entries.length > 0) {
    const missingEntries = params.entries.filter((entry) => !seenKeys.has(entry.key));
    if (missingEntries.length > 0) {
      await appendConfiguredRows({
        rows: params.rows,
        entries: missingEntries,
        modelRegistry: params.modelRegistry,
        context: params.context,
        seenKeys,
      });
    }
  }
}

/** Appends the configured/default rows used by the cheap default list path. */
export async function appendConfiguredModelRowSources(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
}): Promise<void> {
  if (params.context.cfg.models?.mode === "replace") {
    // In replace mode models.providers is the complete catalog. Starting from
    // default/fallback refs would reintroduce rows absent from that catalog.
    await appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys: new Set(),
    });
    return;
  }
  // Configured rows are emitted first for tag ordering, so they must read the
  // same committed generation the catalog rows below use; otherwise a ref that
  // only exists in a plugin catalog renders default placeholder metadata.
  const catalogSnapshot = await loadListModelCatalogSnapshot(params.context);
  const seenKeys = new Set<string>();
  await appendConfiguredRows({ ...params, catalogSnapshot, seenKeys });
  await appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });
  await appendAuthenticatedCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
    catalogSnapshot,
  });
}
