/** Chooses which source family should back a model-list invocation. */
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

/** Source family selected for a model-list run. */
export type ModelListSourcePlanKind =
  | "registry"
  | "manifest"
  | "provider-index"
  | "provider-runtime-static"
  | "provider-runtime-scoped";

/** Concrete source plan plus preloaded catalog rows and fallback flags. */
export type ModelListSourcePlan = {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows: readonly NormalizedModelCatalogRow[];
};

type ProviderIndexCatalogModule = typeof import("./list.provider-index-catalog.js");
type ManifestCatalogModule = typeof import("./list.manifest-catalog.js");
type ProviderCatalogModule = typeof import("./list.provider-catalog.js");

type ModelListSourcePlanDependencies = Pick<
  ManifestCatalogModule,
  "loadStaticManifestCatalogRowsForList" | "loadSupplementalManifestCatalogRowsForList"
> &
  Pick<ProviderIndexCatalogModule, "loadProviderIndexCatalogRowsForList"> &
  Pick<
    ProviderCatalogModule,
    "hasProviderRuntimeCatalogForFilter" | "hasProviderStaticCatalogForFilter"
  >;

const providerIndexCatalogLoader = createLazyImportLoader<ProviderIndexCatalogModule>(
  () => import("./list.provider-index-catalog.js"),
);

function createSourcePlan(params: {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows?: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows?: readonly NormalizedModelCatalogRow[];
}): ModelListSourcePlan {
  return {
    kind: params.kind,
    manifestCatalogRows: params.manifestCatalogRows ?? [],
    providerIndexCatalogRows: params.providerIndexCatalogRows ?? [],
  };
}

/** Creates the baseline plan that loads the runtime model registry. */
export function createRegistryModelListSourcePlan(): ModelListSourcePlan {
  return createSourcePlan({ kind: "registry" });
}

/** Plans source precedence for all/provider-filtered model-list output. */
export async function planAllModelListSources(params: {
  all?: boolean;
  enableCascade?: boolean;
  providerFilter?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  dependencies?: Partial<ModelListSourcePlanDependencies>;
}): Promise<ModelListSourcePlan> {
  const enableCascade = params.enableCascade ?? params.all;
  if (!enableCascade) {
    return createRegistryModelListSourcePlan();
  }

  const manifestCatalog = await import("./list.manifest-catalog.js");
  const loadStaticManifestCatalogRowsForList =
    params.dependencies?.loadStaticManifestCatalogRowsForList ??
    manifestCatalog.loadStaticManifestCatalogRowsForList;
  const loadSupplementalManifestCatalogRowsForList =
    params.dependencies?.loadSupplementalManifestCatalogRowsForList ??
    manifestCatalog.loadSupplementalManifestCatalogRowsForList;
  if (!params.providerFilter) {
    const providerIndexCatalog = await providerIndexCatalogLoader.load();
    const loadProviderIndexCatalogRowsForList =
      params.dependencies?.loadProviderIndexCatalogRowsForList ??
      providerIndexCatalog.loadProviderIndexCatalogRowsForList;
    return createSourcePlan({
      kind: "registry",
      manifestCatalogRows: loadSupplementalManifestCatalogRowsForList({
        cfg: params.cfg,
        metadataSnapshot: params.metadataSnapshot,
      }),
      providerIndexCatalogRows: loadProviderIndexCatalogRowsForList({
        cfg: params.cfg,
      }),
    });
  }

  const providerCatalog = await import("./list.provider-catalog.js");
  const hasProviderRuntimeCatalogForFilter =
    params.dependencies?.hasProviderRuntimeCatalogForFilter ??
    providerCatalog.hasProviderRuntimeCatalogForFilter;
  const hasProviderStaticCatalogForFilter =
    params.dependencies?.hasProviderStaticCatalogForFilter ??
    providerCatalog.hasProviderStaticCatalogForFilter;

  const staticManifestCatalogRows = loadStaticManifestCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (staticManifestCatalogRows.length > 0) {
    return createSourcePlan({
      kind: "manifest",
      manifestCatalogRows: staticManifestCatalogRows,
    });
  }

  const hasProviderRuntimeCatalog = await hasProviderRuntimeCatalogForFilter({
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (hasProviderRuntimeCatalog) {
    return createSourcePlan({
      kind: "provider-runtime-scoped",
      manifestCatalogRows: loadSupplementalManifestCatalogRowsForList({
        cfg: params.cfg,
        providerFilter: params.providerFilter,
        metadataSnapshot: params.metadataSnapshot,
      }),
    });
  }

  const manifestCatalogRows = loadSupplementalManifestCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });

  if (manifestCatalogRows.length > 0) {
    // Supplemental manifest rows still need the registry for runtime-backed
    // availability and suppression decisions.
    return createSourcePlan({
      kind: "registry",
      manifestCatalogRows,
    });
  }

  const providerIndexCatalog = await providerIndexCatalogLoader.load();
  const loadProviderIndexCatalogRowsForList =
    params.dependencies?.loadProviderIndexCatalogRowsForList ??
    providerIndexCatalog.loadProviderIndexCatalogRowsForList;
  const providerIndexCatalogRows = loadProviderIndexCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
  });
  if (providerIndexCatalogRows.length > 0) {
    return createSourcePlan({
      kind: "provider-index",
      providerIndexCatalogRows,
    });
  }

  const hasProviderStaticCatalog = await hasProviderStaticCatalogForFilter({
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (hasProviderStaticCatalog) {
    return createSourcePlan({ kind: "provider-runtime-static" });
  }

  return createSourcePlan({ kind: "provider-runtime-scoped" });
}
