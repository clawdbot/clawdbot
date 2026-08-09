/** Lists manifest contribution ids from installed plugin registry snapshots. */
import {
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
  type LoadPluginRegistryParams,
  type PluginRegistryContributionKey,
  type PluginRegistrySnapshot,
} from "./plugin-registry.js";

/** Parameters for listing manifest contribution ids from a registry snapshot. */
type ListManifestContributionIdsParams = LoadPluginRegistryParams & {
  contribution: PluginRegistryContributionKey;
  index?: PluginRegistrySnapshot;
  includeDisabled?: boolean;
};

/** Lists ids contributed by plugin manifests for one contribution kind. */
function listManifestContributionIds(params: ListManifestContributionIdsParams): readonly string[] {
  const env = params.env ?? process.env;
  const index =
    params.index ??
    loadPluginRegistrySnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env,
      candidates: params.candidates,
      preferPersisted: params.preferPersisted,
    });
  return listPluginContributionIds({
    index,
    contribution: params.contribution,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    includeDisabled: params.includeDisabled,
  });
}

/** Lists channel ids contributed by plugin manifests. */
export function listManifestChannelContributionIds(
  params: Omit<ListManifestContributionIdsParams, "contribution"> = {},
): readonly string[] {
  return listManifestContributionIds({
    ...params,
    contribution: "channels",
  });
}
