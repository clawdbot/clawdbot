// Resolves official provider plugins implied by configured auth and model selections.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { collectConfiguredOfficialProviderPluginIds } from "./configured-provider-plugin-ids.js";
import { collectConfiguredProviderSelectionIds } from "./configured-provider-selection-ids.js";

/** Lists external provider plugins implied by configured auth profiles and model refs. */
export function collectConfiguredProviderPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const selectedProviderIds = collectConfiguredProviderSelectionIds(params.cfg);
  const pluginIds = new Set(collectConfiguredOfficialProviderPluginIds(params));
  for (const entry of resolveProviderInstallCatalogEntries({
    config: params.cfg,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    if (
      [entry.providerId, ...(entry.providerAliases ?? [])].some((providerId) =>
        selectedProviderIds.has(providerId.toLowerCase()),
      )
    ) {
      pluginIds.add(entry.pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
