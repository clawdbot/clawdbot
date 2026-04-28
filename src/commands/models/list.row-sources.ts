import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  appendCatalogSupplementRows,
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
    let seenKeys = new Set<string>();
    await appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
    });
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
    if (catalogRows === 0 && params.sourcePlan.fallbackToRegistryWhenEmpty) {
      if (!params.modelRegistry) {
        return { requiresRegistryFallback: true };
      }
      await appendDiscoveredRows({
        rows: params.rows,
        models: params.modelRegistry.getAll(),
        modelRegistry: params.modelRegistry,
        context: params.context,
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
  if (params.context.filter.provider) {
    await appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys: new Set(params.rows.map((row) => row.key)),
    });
  }
}
