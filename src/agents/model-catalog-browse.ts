import {
  clampTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";

export const DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS = 750;

export type ModelCatalogBrowseView = "default" | "configured" | "all";

const modelCatalogBrowseDeps = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

export function setModelCatalogBrowseTestDeps(
  overrides: Partial<typeof modelCatalogBrowseDeps>,
): void {
  Object.assign(modelCatalogBrowseDeps, overrides);
}

export function restoreModelCatalogBrowseTestDeps(): void {
  modelCatalogBrowseDeps.setTimeout = globalThis.setTimeout;
  modelCatalogBrowseDeps.clearTimeout = globalThis.clearTimeout;
}

function resolveModelCatalogBrowseTimeoutMs(value: number | undefined): number {
  return (
    clampTimerTimeoutMs(value, 1) ??
    resolveTimerTimeoutMs(DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS, 1)
  );
}

export async function loadModelCatalogForBrowse(params: {
  cfg: OpenClawConfig;
  view?: ModelCatalogBrowseView;
  loadCatalog: (params: { readOnly: boolean }) => Promise<ModelCatalogEntry[]>;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<ModelCatalogEntry[]> {
  const view = params.view ?? "default";
  if (view === "all") {
    return await params.loadCatalog({ readOnly: false });
  }
  if (parseConfiguredModelVisibilityEntries({ cfg: params.cfg }).providerWildcards.size > 0) {
    return await params.loadCatalog({ readOnly: false });
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutMs = resolveModelCatalogBrowseTimeoutMs(params.timeoutMs);
  const timedOut = Symbol("model-catalog-browse-timeout");
  const catalogPromise = params.loadCatalog({ readOnly: true });
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = modelCatalogBrowseDeps.setTimeout(() => resolve(timedOut), timeoutMs);
    timeout.unref?.();
  });

  try {
    const result = await Promise.race([catalogPromise, timeoutPromise]);
    if (result === timedOut) {
      catalogPromise.catch(() => undefined);
      params.onTimeout?.(timeoutMs);
      return [];
    }
    return result;
  } finally {
    if (timeout) {
      modelCatalogBrowseDeps.clearTimeout(timeout);
    }
  }
}
