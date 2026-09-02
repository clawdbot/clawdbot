import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { augmentModelCatalogWithAgentHarnesses } from "../../agents/harness/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
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
  const modelSelections = defaultModel
    ? resolveConfiguredModelEntries({
        cfg: params.cfg,
        agentId: params.agentId,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel,
        ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
        manifestPlugins: params.metadataSnapshot,
      }).entries.map(({ ref }) => ({
        provider: ref.provider,
        modelId: ref.model,
        agentId: params.agentId,
      }))
    : [];
  const snapshot = params.allowHarnessDiscovery
    ? await augmentModelCatalogWithAgentHarnesses({
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
        workspaceDir: params.workspaceDir,
        modelSelections,
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
