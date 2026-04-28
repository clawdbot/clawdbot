import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";

export type ModelListSourcePlanKind =
  | "registry"
  | "manifest"
  | "provider-index"
  | "provider-runtime-static"
  | "provider-runtime-scoped";

export type ModelListSourcePlan = {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows: readonly NormalizedModelCatalogRow[];
  requiresInitialRegistry: boolean;
  skipRuntimeModelSuppression: boolean;
  fallbackToRegistryWhenEmpty: boolean;
};

function createSourcePlan(params: {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows?: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows?: readonly NormalizedModelCatalogRow[];
  requiresInitialRegistry?: boolean;
  skipRuntimeModelSuppression?: boolean;
  fallbackToRegistryWhenEmpty?: boolean;
}): ModelListSourcePlan {
  return {
    kind: params.kind,
    manifestCatalogRows: params.manifestCatalogRows ?? [],
    providerIndexCatalogRows: params.providerIndexCatalogRows ?? [],
    requiresInitialRegistry: params.requiresInitialRegistry ?? false,
    skipRuntimeModelSuppression: params.skipRuntimeModelSuppression ?? false,
    fallbackToRegistryWhenEmpty: params.fallbackToRegistryWhenEmpty ?? false,
  };
}

export function createRegistryModelListSourcePlan(): ModelListSourcePlan {
  return createSourcePlan({
    kind: "registry",
    requiresInitialRegistry: true,
  });
}

export async function planAllModelListSources(params: {
  all?: boolean;
  providerFilter?: string;
  cfg: OpenClawConfig;
}): Promise<ModelListSourcePlan> {
  if (!params.all) {
    return createRegistryModelListSourcePlan();
  }

  const { loadStaticManifestCatalogRowsForList, loadSupplementalManifestCatalogRowsForList } =
    await import("./list.manifest-catalog.js");
  if (!params.providerFilter) {
    const { loadProviderIndexCatalogRowsForList } =
      await import("./list.provider-index-catalog.js");
    return createSourcePlan({
      kind: "registry",
      manifestCatalogRows: loadSupplementalManifestCatalogRowsForList({
        cfg: params.cfg,
      }),
      providerIndexCatalogRows: loadProviderIndexCatalogRowsForList({
        cfg: params.cfg,
      }),
      requiresInitialRegistry: true,
    });
  }

  const staticManifestCatalogRows = loadStaticManifestCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
  });
  const manifestCatalogRows =
    staticManifestCatalogRows.length === 0
      ? loadSupplementalManifestCatalogRowsForList({
          cfg: params.cfg,
          providerFilter: params.providerFilter,
        })
      : staticManifestCatalogRows;

  if (manifestCatalogRows.length > 0) {
    if (staticManifestCatalogRows.length === 0) {
      return createSourcePlan({
        kind: "registry",
        manifestCatalogRows,
        requiresInitialRegistry: true,
      });
    }
    return createSourcePlan({
      kind: "manifest",
      manifestCatalogRows,
      skipRuntimeModelSuppression: true,
    });
  }

  const { loadProviderIndexCatalogRowsForList } = await import("./list.provider-index-catalog.js");
  const providerIndexCatalogRows = loadProviderIndexCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
  });
  if (providerIndexCatalogRows.length > 0) {
    return createSourcePlan({
      kind: "provider-index",
      providerIndexCatalogRows,
      skipRuntimeModelSuppression: true,
    });
  }

  const { hasProviderStaticCatalogForFilter } = await import("./list.provider-catalog.js");
  const hasProviderStaticCatalog = await hasProviderStaticCatalogForFilter({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
  });
  if (hasProviderStaticCatalog) {
    return createSourcePlan({
      kind: "provider-runtime-static",
      skipRuntimeModelSuppression: true,
      fallbackToRegistryWhenEmpty: true,
    });
  }

  return createSourcePlan({
    kind: "provider-runtime-scoped",
  });
}
