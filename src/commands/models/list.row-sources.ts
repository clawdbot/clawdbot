import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  appendCatalogSupplementRows,
  appendAuthenticatedCatalogRows,
  appendConfiguredProviderRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  appendManifestCatalogRows,
  appendModelCatalogRows,
  appendProviderCatalogRows,
  type RowBuilderContext,
} from "./list.rows.js";
import type { ModelListSourcePlan } from "./list.source-plan.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type AllModelRowSources = {
  rows: ModelRow[];
  entries?: ConfiguredEntry[];
  context: RowBuilderContext;
  modelRegistry?: ModelRegistry;
  registryModels?: ReturnType<ModelRegistry["getAll"]>;
  sourcePlan: ModelListSourcePlan;
};

type AppendAllModelRowSourcesResult = {
  requiresRegistryFallback: boolean;
};

export async function appendAllModelRowSources(
  params: AllModelRowSources,
): Promise<AppendAllModelRowSourcesResult> {
  if (params.context.filter.provider && params.sourcePlan.kind !== "registry") {
    const seenKeys = new Set<string>();
    let catalogRows = 0;
    if (params.sourcePlan.kind === "manifest") {
      catalogRows = await appendManifestCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        manifestRows: params.sourcePlan.manifestCatalogRows,
      });
    }
    if (catalogRows === 0 && params.sourcePlan.kind === "provider-index") {
      catalogRows = await appendModelCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        catalogRows: params.sourcePlan.providerIndexCatalogRows,
      });
    }
    if (
      catalogRows === 0 &&
      (params.sourcePlan.kind === "provider-runtime-static" ||
        params.sourcePlan.kind === "provider-runtime-scoped")
    ) {
      catalogRows = await appendProviderCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        staticOnly: params.sourcePlan.kind === "provider-runtime-static",
      });
    }
    if (params.entries && params.entries.length > 0) {
      const missingEntries = params.entries.filter((entry) => !seenKeys.has(entry.key));
      if (missingEntries.length > 0) {
        await appendConfiguredRows({
          rows: params.rows,
          entries: missingEntries,
          modelRegistry: params.modelRegistry,
          context: params.context,
        });
        for (const row of params.rows) {
          seenKeys.add(row.key);
        }
      }
    }
    await appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
    });
    if (
      catalogRows === 0 &&
      params.rows.length === 0 &&
      params.sourcePlan.fallbackToRegistryWhenEmpty
    ) {
      if (!params.modelRegistry) {
        return { requiresRegistryFallback: true };
      }
      await appendDiscoveredRows({
        rows: params.rows,
        models: params.registryModels ?? params.modelRegistry.getAll(),
        modelRegistry: params.modelRegistry,
        context: params.context,
        resolveWithRegistry: false,
      });
    }
    return { requiresRegistryFallback: false };
  }

  const seenKeys = await appendDiscoveredRows({
    rows: params.rows,
    models: params.registryModels ?? params.modelRegistry?.getAll() ?? [],
    modelRegistry: params.modelRegistry,
    context: params.context,
    resolveWithRegistry: Boolean(params.context.filter.provider),
    skipSuppression: Boolean(params.modelRegistry),
  });

  if (params.context.filter.provider && params.entries && params.entries.length > 0) {
    const missingEntries = params.entries.filter((entry) => !seenKeys.has(entry.key));
    if (missingEntries.length > 0) {
      const appendedRowsStart = params.rows.length;
      await appendConfiguredRows({
        rows: params.rows,
        entries: missingEntries,
        modelRegistry: params.modelRegistry,
        context: params.context,
      });
      for (const row of params.rows.slice(appendedRowsStart)) {
        seenKeys.add(row.key);
      }
    }
  }

  await appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  if (params.sourcePlan.manifestCatalogRows.length > 0) {
    await appendManifestCatalogRows({
      rows: params.rows,
      context: { ...params.context, skipRuntimeModelSuppression: true },
      seenKeys,
      manifestRows: params.sourcePlan.manifestCatalogRows,
    });
  }

  if (params.sourcePlan.providerIndexCatalogRows.length > 0) {
    await appendModelCatalogRows({
      rows: params.rows,
      context: { ...params.context, skipRuntimeModelSuppression: true },
      seenKeys,
      catalogRows: params.sourcePlan.providerIndexCatalogRows,
    });
  }

  if (params.modelRegistry && params.context.filter.provider) {
    await appendCatalogSupplementRows({
      rows: params.rows,
      modelRegistry: params.modelRegistry,
      context: params.context,
      seenKeys,
    });
  }
  if (params.modelRegistry) {
    return { requiresRegistryFallback: false };
  }

  await appendProviderCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });
  return { requiresRegistryFallback: false };
}

export async function appendConfiguredModelRowSources(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
}): Promise<void> {
  await appendConfiguredRows(params);
  const seenKeys = new Set(params.rows.map((row) => row.key));
  await appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });
  await appendAuthenticatedCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });
}
