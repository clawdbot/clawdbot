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
type ProviderAuthChecker = (provider: string, modelApi?: string) => boolean | Promise<boolean>;
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";
const OPENAI_CODEX_ROUTABLE_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
]);

function isPromiseLike(value: boolean | Promise<boolean>): value is Promise<boolean> {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}

function isCodexRoutableOpenAIPlatformCatalogEntry(entry: ModelCatalogEntry): boolean {
  return (
    entry.provider.trim().toLowerCase() === OPENAI_PROVIDER_ID &&
    entry.api !== undefined &&
    entry.api !== OPENAI_CODEX_RESPONSES_API &&
    OPENAI_CODEX_ROUTABLE_MODEL_IDS.has(entry.id.trim().toLowerCase())
  );
}

async function resolveProviderAuthCheck(
  providerAuthChecker: ProviderAuthChecker,
  provider: string,
  modelApi?: string,
): Promise<boolean> {
  const result =
    modelApi === undefined
      ? providerAuthChecker(provider)
      : providerAuthChecker(provider, modelApi);
  return isPromiseLike(result) ? await result : result;
}

async function providerHasAuth(
  providerAuthChecker: ProviderAuthChecker,
  entry: ModelCatalogEntry,
): Promise<boolean> {
  if (await resolveProviderAuthCheck(providerAuthChecker, entry.provider, entry.api)) {
    return true;
  }
  return isCodexRoutableOpenAIPlatformCatalogEntry(entry)
    ? await resolveProviderAuthCheck(
        providerAuthChecker,
        entry.provider,
        OPENAI_CODEX_RESPONSES_API,
      )
    : false;
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
      if (await providerHasAuth(hasAuth, entry)) {
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
