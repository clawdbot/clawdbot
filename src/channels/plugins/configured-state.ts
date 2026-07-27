/**
 * Bundled channel configured-state probes.
 *
 * Lists and checks bundled channels that can report configured account state.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

/**
 * Lists bundled channel ids that expose configured-state detectors.
 */
export function listBundledChannelIdsWithConfiguredState(
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelIdsForPackageState("configuredState", discovery);
}

/**
 * Checks whether a bundled channel reports configured state for the current config.
 */
export function hasBundledChannelConfiguredState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  discovery?: PluginDiscoveryResult;
}): boolean {
  return hasBundledChannelPackageState({
    metadataKey: "configuredState",
    channelId: params.channelId,
    cfg: params.cfg,
    env: params.env,
    discovery: params.discovery,
  });
}
