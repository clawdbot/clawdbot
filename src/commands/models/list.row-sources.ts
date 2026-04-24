import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  appendCatalogSupplementRows,
  appendConfiguredProviderRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  appendProviderCatalogRows,
  type RowBuilderContext,
} from "./list.rows.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type AllModelRowSources = {
  rows: ModelRow[];
  context: RowBuilderContext;
  modelRegistry?: ModelRegistry;
  useProviderCatalogFastPath: boolean;
};

type AppendAllModelRowSourcesResult = {
  requiresRegistryFallback: boolean;
};

export function modelRowSourcesRequireRegistry(params: {
  all?: boolean;
  providerFilter?: string;
  useProviderCatalogFastPath: boolean;
}): boolean {
  if (!params.all) {
    return false;
  }
  if (params.providerFilter && params.useProviderCatalogFastPath) {
    return false;
  }
  return true;
}

export async function appendAllModelRowSources(
  params: AllModelRowSources,
): Promise<AppendAllModelRowSourcesResult> {
  if (params.context.filter.provider && params.useProviderCatalogFastPath) {
    let seenKeys = new Set<string>();
    appendConfiguredProviderRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
    });
    const catalogRows = await appendProviderCatalogRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
      staticOnly: true,
    });
    if (catalogRows === 0) {
      if (!params.modelRegistry) {
        return { requiresRegistryFallback: true };
      }
      appendDiscoveredRows({
        rows: params.rows,
        models: params.modelRegistry.getAll(),
        context: params.context,
      });
    }
    return { requiresRegistryFallback: false };
  }

  const seenKeys = appendDiscoveredRows({
    rows: params.rows,
    models: params.modelRegistry?.getAll() ?? [],
    context: params.context,
  });

  appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  if (params.modelRegistry && !params.context.filter.provider) {
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

export function appendConfiguredModelRowSources(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
}): void {
  appendConfiguredRows(params);
}
