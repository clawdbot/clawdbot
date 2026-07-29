/**
 * Bundled channel id listing helpers.
 *
 * Reads generated channel catalog entries for current package/cache scope.
 */
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";

/**
 * Lists bundled channel ids for a package root/cache scope.
 */
function listBundledChannelIdsForRoot(
  _packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listChannelCatalogEntries({
    origin: "bundled",
    env,
    discovery,
  })
    .map((entry) => entry.channel.id)
    .filter((channelId): channelId is string => Boolean(channelId))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists bundled channel ids for the current runtime root scope.
 */
export function listBundledChannelIds(
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelIdsForRoot(resolveBundledChannelRootScope(env).cacheKey, env, discovery);
}
