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
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
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
  agentId?: string;
  view?: ModelCatalogBrowseView;
}): boolean {
  const view = params.view ?? "default";
  if (view === "all") {
    return true;
  }
  const visibility = parseConfiguredModelVisibilityEntries({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (visibility.providerWildcards.size === 0) {
    return false;
  }
  // An explicit modelPolicy.allow provider wildcard makes model pickers,
  // configured views, and provider-config inventory resolve against the
  // discovered catalog so key-scoped runtime rows appear without an explicit
  // allowlist entry (see openclaw#115953). Legacy agents.defaults.models
  // wildcard entries keep the historical read-only default path and only
  // escalate the configured view, as before.
  if (visibility.configPath === LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH) {
    return view === "configured";
  }
  return true;
}

function resolveModelCatalogBrowseTimeoutMs(value: number | undefined): number {
  return (
    clampTimerTimeoutMs(value, 1) ??
    resolveTimerTimeoutMs(DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS, 1)
  );
}

async function loadCatalogForBrowse<T>(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  view?: ModelCatalogBrowseView;
  preparedOnly?: boolean;
  refresh?: boolean;
  loadCatalog: (params: { readOnly: boolean; refresh?: boolean }) => Promise<T>;
  empty: T;
  timeoutFullDiscovery?: boolean;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<T> {
  const view = params.view ?? "default";
  const requiresFullDiscovery =
    params.preparedOnly !== true &&
    modelCatalogBrowseRequiresFullDiscovery({
      cfg: params.cfg,
      agentId: params.agentId,
      view,
    });
  // Implicit inventory reads stay bounded; explicit refreshes complete unless their caller
  // explicitly requests a full-discovery deadline.
  const shouldTimeoutFullDiscovery =
    params.timeoutFullDiscovery === true ||
    (params.refresh !== true &&
      requiresFullDiscovery &&
      (view === "default" || view === "provider-config"));
  if ((requiresFullDiscovery || params.refresh === true) && !shouldTimeoutFullDiscovery) {
    return await params.loadCatalog({
      readOnly: !requiresFullDiscovery,
      ...(requiresFullDiscovery && params.refresh ? { refresh: true } : {}),
    });
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutMs = resolveModelCatalogBrowseTimeoutMs(params.timeoutMs);
  const catalogPromise = params.loadCatalog({
    readOnly: !requiresFullDiscovery,
    ...(requiresFullDiscovery && params.refresh ? { refresh: true } : {}),
  });
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
  agentId?: string;
  view?: ModelCatalogBrowseView;
  /** Never starts provider discovery; a completed generation cache may still be reused. */
  preparedOnly?: boolean;
  /** Replaces the completed generation cache when discovery is otherwise required. */
  refresh?: boolean;
  loadCatalog: (params: { readOnly: boolean; refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
  timeoutFullDiscovery?: boolean;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<ModelCatalogSnapshot> {
  return loadCatalogForBrowse({ ...params, empty: { entries: [], routeVariants: [] } });
}
