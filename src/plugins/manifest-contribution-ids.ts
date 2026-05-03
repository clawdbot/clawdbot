import {
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
  type LoadPluginRegistryParams,
  type PluginRegistryContributionKey,
  type PluginRegistrySnapshot,
} from "./plugin-registry.js";

export type ListManifestContributionIdsParams = LoadPluginRegistryParams & {
  contribution: PluginRegistryContributionKey;
  index?: PluginRegistrySnapshot;
  includeDisabled?: boolean;
};

export function listManifestContributionIds(
  params: ListManifestContributionIdsParams,
): readonly string[] {
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

export function listManifestChannelContributionIds(
  params: Omit<ListManifestContributionIdsParams, "contribution"> = {},
): readonly string[] {
  return listManifestContributionIds({
    ...params,
    contribution: "channels",
  });
}

export function listManifestProviderContributionIds(
  params: Omit<ListManifestContributionIdsParams, "contribution"> = {},
): readonly string[] {
  return listManifestContributionIds({
    ...params,
    contribution: "providers",
  });
}
