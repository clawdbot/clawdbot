import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import "./models-config.providers.implicit.js";

type ResolveProviderDiscoveryFilterParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveOwners?: (provider: string) => readonly string[] | undefined;
  providerIds?: readonly string[];
};

type ModelsConfigImplicitProvidersTestApi = {
  resolveProviderDiscoveryFilterForTest(
    params: ResolveProviderDiscoveryFilterParams,
  ): string[] | undefined;
  resolvePluginMetadataProviderOwnersForTest(
    pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "owners"> | undefined,
    provider: string,
  ): readonly string[] | undefined;
};

function getTestApi(): ModelsConfigImplicitProvidersTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.modelsConfigImplicitProvidersTestApi")
  ] as ModelsConfigImplicitProvidersTestApi;
}

export const resolveProviderDiscoveryFilterForTest = (
  params: ResolveProviderDiscoveryFilterParams,
): string[] | undefined => getTestApi().resolveProviderDiscoveryFilterForTest(params);

export const resolvePluginMetadataProviderOwnersForTest = (
  pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "owners"> | undefined,
  provider: string,
): readonly string[] | undefined =>
  getTestApi().resolvePluginMetadataProviderOwnersForTest(pluginMetadataSnapshot, provider);
