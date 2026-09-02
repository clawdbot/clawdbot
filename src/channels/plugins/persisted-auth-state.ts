/**
 * Bundled channel persisted-auth state probes.
 *
 * Lists and checks channel package metadata that can report persisted auth state.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

/**
 * Lists bundled channels that declare persisted-auth state metadata.
 */
export function listBundledChannelIdsWithPersistedAuthState(
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelIdsForPackageState("persistedAuthState", discovery);
}

/**
 * Returns whether a bundled channel reports persisted auth state.
 */
export function hasBundledChannelPersistedAuthState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  discovery?: PluginDiscoveryResult;
}): boolean {
  return hasBundledChannelPackageState({
    metadataKey: "persistedAuthState",
    channelId: params.channelId,
    cfg: params.cfg,
    env: params.env,
    discovery: params.discovery,
  });
}
