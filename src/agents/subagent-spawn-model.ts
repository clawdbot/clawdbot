import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { supportsModelTools } from "./model-tool-support.js";
import { summarizeSpawnError } from "./spawn-pipeline.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import { loadPreparedModelCatalog } from "./subagent-spawn.runtime.js";

export function buildResolvedSubagentModelMetadata(resolvedModel?: string): {
  resolvedModel?: string;
  resolvedProvider?: string;
} {
  const modelRef = resolvedModel?.trim();
  if (!modelRef) {
    return {};
  }
  const { provider } = splitModelRef(modelRef);
  return {
    resolvedModel: modelRef,
    ...(provider ? { resolvedProvider: provider } : {}),
  };
}

export async function resolveCollectorOutputModelError(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentDir: string;
  workspaceDir?: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const selected = splitModelRef(params.resolvedModel);
  const fallback = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.targetAgentId,
  });
  const provider = selected.provider ?? fallback.provider;
  const model = selected.model ?? fallback.model;
  if (!provider || !model) {
    return undefined;
  }
  let catalog: Awaited<ReturnType<typeof loadPreparedModelCatalog>>;
  try {
    catalog = await getSubagentSpawnDeps().loadPreparedModelCatalog({
      config: params.cfg,
      agentDir: params.targetAgentDir,
      workspaceDir: params.workspaceDir,
    });
  } catch (error) {
    return `sessions_spawn could not verify outputSchema model capabilities: ${summarizeSpawnError(error)}`;
  }
  const entry = findModelCatalogEntry(catalog, { provider, modelId: model });
  if (!entry || supportsModelTools(entry)) {
    return undefined;
  }
  return `sessions_spawn outputSchema requires a tool-capable target model; "${provider}/${model}" declares compat.supportsTools=false.`;
}
