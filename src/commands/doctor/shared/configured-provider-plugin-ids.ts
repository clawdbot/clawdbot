// Resolves official external provider plugins implied by config and environment state.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
} from "../../../plugins/official-external-plugin-catalog.js";
import {
  collectConfiguredMediaProviderSelectionIds,
  collectConfiguredModelProviderSelectionIds,
} from "./configured-provider-selection-ids.js";

/** Lists official external provider plugins without loading installed plugin registries. */
export function collectConfiguredOfficialProviderPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const configuredProviderIds = collectConfiguredModelProviderSelectionIds(params.cfg);
  const configuredMediaProviderIds = collectConfiguredMediaProviderSelectionIds(params.cfg);
  const pluginIds = new Set(
    resolveOfficialExternalProviderPluginIds({ providerIds: configuredProviderIds }),
  );
  for (const pluginId of resolveOfficialExternalProviderPluginIdsForEnv(
    params.env ?? process.env,
  )) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "mediaUnderstandingProviders",
    providerIds: configuredMediaProviderIds,
  })) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "speechProviders",
    providerIds: configuredProviderIds,
  })) {
    pluginIds.add(pluginId);
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
