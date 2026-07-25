// ClawHub-backed discovery for installable plugin package families.
import {
  searchClawHubPackages,
  type ClawHubPackageFamily,
  type ClawHubPackageSearchResult,
} from "../infra/clawhub.js";

const INSTALLABLE_PLUGIN_FAMILIES: readonly ClawHubPackageFamily[] = [
  "code-plugin",
  "bundle-plugin",
];
const DEFAULT_PLUGIN_SEARCH_LIMIT = 20;
const MAX_PLUGIN_SEARCH_LIMIT = 100;

type PluginCatalogSearchParams = {
  query: string;
  limit?: number;
};

function resolveSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return DEFAULT_PLUGIN_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PLUGIN_SEARCH_LIMIT);
}

function mergePackageSearchResults(
  groups: readonly ClawHubPackageSearchResult[][],
  limit: number,
): ClawHubPackageSearchResult[] {
  const byName = new Map<string, ClawHubPackageSearchResult>();
  for (const entry of groups.flat()) {
    const existing = byName.get(entry.package.name);
    if (!existing || entry.score > existing.score) {
      byName.set(entry.package.name, entry);
    }
  }
  // Stable sorting preserves family query order when ClawHub scores tie.
  return [...byName.values()].toSorted((left, right) => right.score - left.score).slice(0, limit);
}

/** Searches installable ClawHub plugin families and merges duplicate packages by best score. */
export async function searchInstallablePluginPackages(
  params: PluginCatalogSearchParams,
): Promise<ClawHubPackageSearchResult[]> {
  const limit = resolveSearchLimit(params.limit);
  const groups = await Promise.all(
    INSTALLABLE_PLUGIN_FAMILIES.map((family) =>
      searchClawHubPackages({
        query: params.query,
        family,
        limit,
      }),
    ),
  );
  return mergePackageSearchResults(groups, limit);
}
