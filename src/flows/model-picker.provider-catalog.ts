// Model picker provider choices projected from the lifecycle-owned catalog.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import {
  canonicalizePreparedModelCatalogProvider,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

/** Loads committed catalog models for the user's preferred provider. */
export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ entries: ModelCatalogEntry[]; metadataSnapshot: PluginMetadataSnapshot }> {
  const requestedProvider = normalizeProviderId(params.preferredProvider);
  const agentDir =
    params.agentDir ??
    (params.agentId
      ? resolveAgentDir(params.cfg, params.agentId, params.env)
      : resolveDefaultAgentDir(params.cfg, params.env));
  if (!requestedProvider) {
    const owner = await loadPreparedModelCatalogOwnerSnapshot({
      config: params.cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      agentDir,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
    });
    return { entries: [], metadataSnapshot: owner.metadataSnapshot };
  }
  const owner = await loadPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  const providerFilter = canonicalizePreparedModelCatalogProvider(
    requestedProvider,
    owner.metadataSnapshot,
  );
  return {
    entries: owner.modelCatalog.entries.filter(
      (entry) => normalizeProviderId(entry.provider) === providerFilter,
    ),
    metadataSnapshot: owner.metadataSnapshot,
  };
}
