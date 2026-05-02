import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasManifestContractValue,
  listAvailableManifestContractPlugins,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export type ManifestContractRuntimePluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
};

const DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS = {
  preferPersisted: false,
} as const;

export function resolveManifestContractRuntimePluginResolution(params: {
  cfg?: OpenClawConfig;
  contract: PluginManifestContractListKey;
  value?: string;
}): ManifestContractRuntimePluginResolution {
  const snapshot = loadPluginMetadataSnapshot({
    config: params.cfg ?? {},
    env: process.env,
    ...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS,
  });
  const allContractPlugins = snapshot.plugins.filter((plugin) =>
    hasManifestContractValue({
      plugin,
      contract: params.contract,
      value: params.value,
    }),
  );
  const bundledCompatPluginIds = allContractPlugins
    .filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.id);
  const pluginIds = listAvailableManifestContractPlugins({
    snapshot: { index: snapshot.index, plugins: allContractPlugins },
    contract: params.contract,
    value: params.value,
    config: params.cfg,
  }).map((plugin) => plugin.id);
  return {
    pluginIds: [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right)),
    bundledCompatPluginIds: [...new Set(bundledCompatPluginIds)].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}
