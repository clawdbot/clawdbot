import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
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
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type AllModelRowSources = {
  rows: ModelRow[];
  context: RowBuilderContext;
  modelRegistry?: ModelRegistry;
  manifestCatalogRows?: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows?: readonly NormalizedModelCatalogRow[];
  useManifestCatalogFastPath: boolean;
  useProviderCatalogFastPath: boolean;
  useProviderIndexCatalogFastPath: boolean;
};

type AppendAllModelRowSourcesResult = {
  requiresRegistryFallback: boolean;
};

export function modelRowSourcesRequireRegistry(params: {
  all?: boolean;
  providerFilter?: string;
  useManifestCatalogFastPath: boolean;
  useProviderCatalogFastPath: boolean;
  useProviderIndexCatalogFastPath: boolean;
}): boolean {
  if (!params.all) {
    return false;
  }
  if (params.providerFilter) {
    return false;
  }
  return true;
}

export async function appendAllModelRowSources(
  params: AllModelRowSources,
): Promise<AppendAllModelRowSourcesResult> {
  if (
    params.context.filter.provider &&
    (params.useManifestCatalogFastPath ||
      params.useProviderCatalogFastPath ||
      params.useProviderIndexCatalogFastPath)
  ) {
    let seenKeys = new Set<string>();
    await appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
    });
    let catalogRows = 0;
    if (params.useManifestCatalogFastPath) {
      catalogRows = await appendManifestCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        manifestRows: params.manifestCatalogRows ?? [],
      });
    }
    if (catalogRows === 0 && params.useProviderCatalogFastPath) {
      catalogRows = await appendProviderCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        staticOnly: true,
      });
    }
    if (catalogRows === 0 && params.useProviderIndexCatalogFastPath) {
      catalogRows = await appendModelCatalogRows({
        rows: params.rows,
        context: params.context,
        seenKeys,
        catalogRows: params.providerIndexCatalogRows ?? [],
      });
    }
    if (catalogRows === 0) {
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
    models: params.modelRegistry?.getAll() ?? [],
    modelRegistry: params.modelRegistry,
    context: params.context,
  });

  await appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  if (params.modelRegistry) {
    await appendCatalogSupplementRows({
      rows: params.rows,
      modelRegistry: params.modelRegistry,
      context: params.context,
      seenKeys,
    });
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
