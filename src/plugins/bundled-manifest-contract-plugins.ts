/** Resolves enabled bundled plugins that advertise a specific manifest contract list. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledCompatActivationInputs } from "./activation-context.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { loadManifestContractSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";

/** Lists bundled plugin ids with a non-empty contract contribution in a manifest snapshot. */
function listBundledManifestContractPluginIds(params: {
  plugins: readonly PluginManifestRecord[];
  contract: PluginManifestContractListKey;
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  return params.plugins
    .filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (plugin.contracts?.[params.contract]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

/** Applies config activation and compatibility rules before returning bundled contract owners. */
export function resolveEnabledBundledManifestContractPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
  contract: PluginManifestContractListKey;
  manifestRecords?: readonly PluginManifestRecord[];
}): PluginManifestRecord[] {
  if (params.config?.plugins?.enabled === false) {
    return [];
  }
  let manifestRecords = params.manifestRecords;
  const loadManifestRecords = () => {
    manifestRecords ??= loadManifestContractSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).plugins;
    return manifestRecords;
  };

  const activation = resolveBundledCompatActivationInputs({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    applyAutoEnable: true,
    resolveBundledPluginIds: (compatParams) =>
      listBundledManifestContractPluginIds({
        plugins: loadManifestRecords(),
        contract: params.contract,
        onlyPluginIds: compatParams.onlyPluginIds,
      }),
  });
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  return loadManifestRecords().filter((plugin) => {
    if (
      plugin.origin !== "bundled" ||
      (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) ||
      (plugin.contracts?.[params.contract]?.length ?? 0) === 0
    ) {
      return false;
    }
    return resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      channelIds: plugin.channels,
      config: activation.normalized,
      rootConfig: activation.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
      activationSource: activation.activationSource,
    }).enabled;
  });
}
