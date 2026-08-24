// Model picker provider choices projected from the lifecycle-owned catalog.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { canonicalizePreparedModelCatalogProvider } from "../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { loadPreparedModelCatalogSnapshot } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

function filterProviderSnapshot(
  snapshot: ModelCatalogSnapshot,
  provider: string,
): ModelCatalogSnapshot {
  const matchesProvider = (entry: { provider: string }) =>
    normalizeProviderId(entry.provider) === provider;
  return {
    entries: snapshot.entries.filter(matchesProvider),
    routeVariants: snapshot.routeVariants.filter(matchesProvider),
    ...(snapshot.staticEntries
      ? { staticEntries: snapshot.staticEntries.filter(matchesProvider) }
      : {}),
  };
}

/** Loads committed catalog models for the user's preferred provider. */
export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogSnapshot> {
  const requestedProvider = normalizeProviderId(params.preferredProvider);
  if (!requestedProvider) {
    return { entries: [], routeVariants: [] };
  }
  const env = params.env ?? process.env;
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    config: params.cfg,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const providerFilter = canonicalizePreparedModelCatalogProvider(
    requestedProvider,
    metadataSnapshot,
  );
  const snapshot = await loadPreparedModelCatalogSnapshot({
    config: params.cfg,
    agentDir: params.agentDir ?? resolveDefaultAgentDir(params.cfg, params.env),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.env ? { env: params.env } : {}),
    readOnly: true,
    providerDiscoveryProviderIds: [providerFilter],
    scopedLiveProviderDiscovery: true,
  });
  return filterProviderSnapshot(snapshot, providerFilter);
}
