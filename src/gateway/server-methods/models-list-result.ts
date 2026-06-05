// Model list result building resolves visible model catalogs for an agent and
// strips runtime-only provider params before sending the browse API payload.
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;

let loggedSlowModelsListCatalog = false;

// Unknown views are rejected by protocol validation first; this helper keeps the
// handler default explicit for older clients that omit the field.
function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

// Runtime-only model params are useful inside provider routing, but exposing
// them here would leak provider invocation details into the Control UI API.
function omitRuntimeModelParams(entry: ModelCatalogEntry): ModelCatalogEntry {
  const { params: _params, ...rest } = entry as ModelCatalogEntry & {
    params?: Record<string, unknown>;
  };
  return rest;
}

function omitRuntimeModelParamsFromCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.map(omitRuntimeModelParams);
}

export async function buildModelsListResult(params: {
  context: GatewayRequestContext;
  agentId?: string;
  params: Record<string, unknown>;
}): Promise<{ models: ModelCatalogEntry[] }> {
  const cfg = params.context.getRuntimeConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const view = resolveModelsListView(params.params);
  const catalog = await loadModelCatalogForBrowse({
    cfg,
    view,
    loadCatalog: params.context.loadGatewayModelCatalog,
    onTimeout: (timeoutMs) => {
      if (loggedSlowModelsListCatalog) {
        return;
      }
      loggedSlowModelsListCatalog = true;
      params.context.logGateway.debug(
        `models.list continuing without model catalog after ${timeoutMs}ms`,
      );
    },
  });
  if (view === "all") {
    return { models: omitRuntimeModelParamsFromCatalog(catalog) };
  }
  const models = await resolveVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: resolveAgentEffectiveModelPrimary(cfg, agentId),
    agentId,
    workspaceDir,
    view,
    runtimeAuthDiscovery: false,
  });
  return { models: omitRuntimeModelParamsFromCatalog(models) };
}
