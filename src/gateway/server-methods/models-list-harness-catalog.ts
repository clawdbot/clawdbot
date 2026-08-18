import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { augmentModelCatalogWithAgentHarness } from "../../agents/harness/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { includeConfiguredStaticCatalogEntries } from "./models-list-configured-static.js";

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
  const snapshot = params.allowHarnessDiscovery
    ? await augmentModelCatalogWithAgentHarness({
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
        workspaceDir: params.workspaceDir,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel,
        snapshot: params.snapshot,
        onError: params.onError,
      })
    : params.snapshot;
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
