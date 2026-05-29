import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";
import { modelKey } from "./model-selection-normalize.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import {
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  createModelVisibilityPolicy,
} from "./model-visibility-policy.js";

type ModelCatalogVisibilityView = "default" | "configured" | "all";
type ProviderAuthChecker = (provider: string) => boolean | Promise<boolean>;

function isPromiseLike(value: boolean | Promise<boolean>): value is Promise<boolean> {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}

async function providerHasAuth(
  providerAuthChecker: ProviderAuthChecker,
  provider: string,
): Promise<boolean> {
  const result = providerAuthChecker(provider);
  return isPromiseLike(result) ? await result : result;
}

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

export async function resolveVisibleModelCatalog(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  view?: ModelCatalogVisibilityView;
  runtimeAuthDiscovery?: boolean;
  providerAuthChecker?: ProviderAuthChecker;
}): Promise<ModelCatalogEntry[]> {
  if (params.view === "all") {
    return params.catalog;
  }

  const buildDefaultVisibleCatalog = async () => {
    const configuredCatalog = sortModelCatalogEntries(
      buildConfiguredModelCatalog({ cfg: params.cfg }),
    );
    const hasAuth =
      params.providerAuthChecker ??
      createProviderAuthChecker({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        agentId: params.agentId,
        env: params.env,
        allowPluginSyntheticAuth: params.runtimeAuthDiscovery,
        discoverExternalCliAuth: params.runtimeAuthDiscovery,
      });
    const authBackedCatalog: ModelCatalogEntry[] = [];
    for (const entry of params.catalog) {
      if (await providerHasAuth(hasAuth, entry.provider)) {
        authBackedCatalog.push(entry);
      }
    }
    return sortModelCatalogEntries(
      dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]),
    );
  };

  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  });
  const defaultVisibleCatalog =
    policy.allowAny || policy.hasProviderWildcards ? await buildDefaultVisibleCatalog() : [];
  return sortModelCatalogEntries(
    dedupeModelCatalogEntries(
      policy.visibleCatalog({
        catalog: params.catalog,
        defaultVisibleCatalog,
        view: params.view,
      }),
    ),
  );
}
