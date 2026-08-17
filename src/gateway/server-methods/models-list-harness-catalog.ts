import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { augmentModelCatalogWithAgentHarness } from "../../agents/harness/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { includeConfiguredStaticCatalogEntries } from "./models-list-configured-static.js";

export async function augmentExplicitModelsListWithHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir: string;
  defaultModel?: string;
  snapshot: ModelCatalogSnapshot;
  enabled: boolean;
  onError?: (error: unknown) => void;
}): Promise<ModelCatalogSnapshot> {
  if (!params.enabled) {
    return params.snapshot;
  }
  return await augmentModelCatalogWithAgentHarness({
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
    workspaceDir: params.workspaceDir,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: params.defaultModel,
    snapshot: params.snapshot,
    onError: params.onError,
  });
}

export async function prepareModelsListHarnessCatalog(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir: string;
  snapshot: ModelCatalogSnapshot;
  view: "default" | "configured" | "provider-config" | "all";
  metadataSnapshot: PluginMetadataSnapshot;
  allowHarnessDiscovery: boolean;
  onError?: (error: unknown) => void;
}) {
  const defaultModel = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const snapshot = await augmentExplicitModelsListWithHarness({
    ...params,
    defaultModel,
    enabled: params.allowHarnessDiscovery,
  });
  return {
    snapshot,
    defaultModel,
    catalog: includeConfiguredStaticCatalogEntries({
      ...params,
      snapshot,
      defaultModel,
      enabled: params.view === "configured",
    }),
  };
}
