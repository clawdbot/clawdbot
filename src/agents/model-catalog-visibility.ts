import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";
import { buildAllowedModelSet, buildConfiguredModelCatalog, modelKey } from "./model-selection.js";

type ModelCatalogVisibilityView = "default" | "configured" | "all";

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}

function dedupeModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const next: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key = modelKey(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(entry);
  }
  return next;
}

export function resolveVisibleModelCatalog(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  view?: ModelCatalogVisibilityView;
  runtimeAuthDiscovery?: boolean;
}): ModelCatalogEntry[] {
  if (params.view === "all") {
    return params.catalog;
  }

  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
  });
  if (!allowed.allowAny && allowed.allowedCatalog.length > 0) {
    return sortModelCatalogEntries(allowed.allowedCatalog);
  }

  const configuredCatalog = sortModelCatalogEntries(
    buildConfiguredModelCatalog({ cfg: params.cfg }),
  );
  const hasAuth = createProviderAuthChecker({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    env: params.env,
    allowPluginSyntheticAuth: params.runtimeAuthDiscovery,
    discoverExternalCliAuth: params.runtimeAuthDiscovery,
  });
  const authBackedCatalog = params.catalog.filter((entry) => hasAuth(entry.provider));
  return sortModelCatalogEntries(
    dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]),
  );
}
