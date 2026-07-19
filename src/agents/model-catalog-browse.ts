/**
 * Loads model catalog views for browse/search UI surfaces.
 */
import {
  clampTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  buildConfiguredModelCatalog,
  parseConfiguredModelVisibilityEntries,
} from "./model-selection-shared.js";

/**
 * Loads the model catalog shape used by browse/list commands without letting optional
 * provider discovery stall the CLI path.
 */
const DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS = 750;

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

/** True when a browse view requires the full published catalog generation. */
export function modelCatalogBrowseRequiresFullDiscovery(params: {
  cfg: OpenClawConfig;
  view?: ModelCatalogBrowseView;
}): boolean {
  const view = params.view ?? "default";
  return (
    view === "all" ||
    (view === "configured" &&
      parseConfiguredModelVisibilityEntries({ cfg: params.cfg }).providerWildcards.size > 0)
  );
}

function resolveModelCatalogBrowseTimeoutMs(value: number | undefined): number {
  return (
    clampTimerTimeoutMs(value, 1) ??
    resolveTimerTimeoutMs(DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS, 1)
  );
}

async function loadCatalogForBrowse<T>(params: {
  cfg: OpenClawConfig;
  view?: ModelCatalogBrowseView;
  loadCatalog: (params: { readOnly: boolean }) => Promise<T>;
  empty: T;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<T> {
  const view = params.view ?? "default";
  if (modelCatalogBrowseRequiresFullDiscovery({ cfg: params.cfg, view })) {
    return await params.loadCatalog({ readOnly: false });
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutMs = resolveModelCatalogBrowseTimeoutMs(params.timeoutMs);
  const catalogPromise = params.loadCatalog({ readOnly: true });
  const catalogResult = catalogPromise.then((value) => ({ kind: "catalog" as const, value }));
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    timeout.unref?.();
  });

  try {
    const result = await Promise.race([catalogResult, timeoutPromise]);
    if (result.kind === "timeout") {
      // The browse path may return partial/empty results; keep late catalog failures off stderr.
      catalogPromise.catch(() => undefined);
      params.onTimeout?.(timeoutMs);
      return params.empty;
    }
    return result.value;
  } finally {
    if (timeout) {
      globalThis.clearTimeout(timeout);
    }
  }
}

/** Loads an explicit logical/physical catalog snapshot for route-aware browse surfaces. */
export function loadPreparedModelCatalogSnapshotForBrowse(params: {
  cfg: OpenClawConfig;
  view?: ModelCatalogBrowseView;
  loadCatalog: (params: { readOnly: boolean }) => Promise<ModelCatalogSnapshot>;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<ModelCatalogSnapshot> {
  return loadCatalogForBrowse({ ...params, empty: { entries: [], routeVariants: [] } });
}
