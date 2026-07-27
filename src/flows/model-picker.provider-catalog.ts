// Model picker provider choices projected from the lifecycle-owned catalog.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import {
  canonicalizePreparedModelCatalogProvider,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Loads committed catalog models for the user's preferred provider. */
export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogEntry[]> {
  const requestedProvider = normalizeProviderId(params.preferredProvider);
  if (!requestedProvider) {
    return [];
  }
  const owner = await loadPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentDir: params.agentDir ?? resolveDefaultAgentDir(params.cfg, params.env),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  const providerFilter = canonicalizePreparedModelCatalogProvider(
    requestedProvider,
    owner.metadataSnapshot,
  );
  return owner.modelCatalog.entries.filter(
    (entry) => normalizeProviderId(entry.provider) === providerFilter,
  );
}
