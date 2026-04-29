import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";

export function listBundledChannelPluginIdsForRoot(
  _packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return listChannelCatalogEntries({ origin: "bundled", env })
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledChannelPluginIds(): string[] {
  return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope().cacheKey);
}
