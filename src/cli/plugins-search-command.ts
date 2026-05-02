import {
  searchClawHubPackages,
  type ClawHubPackageFamily,
  type ClawHubPackageSearchResult,
} from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { theme } from "../terminal/theme.js";

export type PluginsSearchOptions = {
  json?: boolean;
  limit?: number;
};

const INSTALLABLE_PLUGIN_FAMILIES: ClawHubPackageFamily[] = ["code-plugin", "bundle-plugin"];

function clampSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return 20;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
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
  return [...byName.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);
}

function formatPackageSearchLine(entry: ClawHubPackageSearchResult): string {
  const pkg = entry.package;
  const flags = [
    pkg.family,
    pkg.channel,
    pkg.isOfficial ? "official" : undefined,
    pkg.latestVersion ? `v${pkg.latestVersion}` : undefined,
  ].filter(Boolean);
  const summary = pkg.summary ? `  ${theme.muted(pkg.summary)}` : "";
  return `${pkg.name}  ${theme.muted(flags.join(" | "))}${summary}\n  ${theme.muted(`Install: openclaw plugins install clawhub:${pkg.name}`)}`;
}

export async function runPluginsSearchCommand(
  queryParts: string[] | string,
  opts: PluginsSearchOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const query = normalizeOptionalString(
    Array.isArray(queryParts) ? queryParts.join(" ") : queryParts,
  );
  if (!query) {
    runtime.error("Usage: openclaw plugins search <query>");
    return runtime.exit(1);
  }

  const limit = clampSearchLimit(opts.limit);
  try {
    const groups = await Promise.all(
      INSTALLABLE_PLUGIN_FAMILIES.map((family) =>
        searchClawHubPackages({
          query,
          family,
          limit,
        }),
      ),
    );
    const results = mergePackageSearchResults(groups, limit);

    if (opts.json) {
      writeRuntimeJson(runtime, { results });
      return;
    }
    if (results.length === 0) {
      runtime.log("No ClawHub plugins found.");
      return;
    }
    runtime.log(`${theme.heading("ClawHub plugins")} ${theme.muted(`(${results.length})`)}`);
    runtime.log(results.map(formatPackageSearchLine).join("\n"));
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    runtime.exit(1);
  }
}
