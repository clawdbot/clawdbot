// Collects dangerous config flag findings from the current config shape.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectPluginConfigContractMatches } from "../plugins/config-contract-matches.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestConfigContracts } from "../plugins/manifest.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { isRecord } from "../utils.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";

type PluginConfigContractMetadata = {
  origin: PluginOrigin;
  configContracts: PluginManifestConfigContracts;
};

function resolveCurrentPluginConfigContractsById(params: {
  cfg: OpenClawConfig;
  pluginIds: readonly string[];
}): ReadonlyMap<string, PluginConfigContractMetadata> | undefined {
  // Gateway startup already owns this metadata snapshot; reuse it here so
  // warning logs do not reload plugin manifests on the ready path.
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!snapshot) {
    return undefined;
  }

  const contractsById = new Map<string, PluginConfigContractMetadata>();
  for (const pluginId of params.pluginIds) {
    const normalizedPluginId = snapshot.normalizePluginId(pluginId);
    const plugin = snapshot.byPluginId.get(pluginId) ?? snapshot.byPluginId.get(normalizedPluginId);
    if (!plugin) {
      return undefined;
    }
    if (!plugin.configContracts) {
      continue;
    }
    contractsById.set(pluginId, {
      origin: plugin.origin,
      configContracts: plugin.configContracts,
    });
  }
  return contractsById;
}

/**
 * Collect dangerous flags using the gateway's current plugin metadata snapshot when it is complete.
 * Returns undefined when any configured plugin is missing so callers can use manifest discovery.
 */
export function collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot(
  cfg: OpenClawConfig,
): string[] | undefined {
  const pluginEntries = cfg.plugins?.entries;
  if (!isRecord(pluginEntries)) {
    return collectEnabledInsecureOrDangerousFlagsFromContracts(cfg);
  }
  const pluginIds = Object.keys(pluginEntries);
  const configContracts = resolveCurrentPluginConfigContractsById({ cfg, pluginIds });
  if (!configContracts) {
    return undefined;
  }
  return collectEnabledInsecureOrDangerousFlagsFromContracts(cfg, {
    collectPluginConfigContractMatches,
    configContractsById: configContracts,
  });
}
