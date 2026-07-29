// ClawHub-backed plugin search command; queries installable plugin families and merges scores.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { ClawHubPackageSearchResult } from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { searchInstallablePluginPackages } from "../plugins/catalog-search.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";

/** Options accepted by `openclaw plugins search`. */
type PluginsSearchOptions = {
  json?: boolean;
  limit?: number;
};

function formatPackageSearchLine(entry: ClawHubPackageSearchResult): string {
  const pkg = entry.package;
  const flags = [
    pkg.family,
    pkg.channel,
    pkg.isOfficial && pkg.channel !== "official" ? "official" : undefined,
    pkg.latestVersion ? `v${pkg.latestVersion}` : undefined,
  ].filter(Boolean);
  const summary = pkg.summary ? theme.muted(` — ${pkg.summary}`) : "";
  return `${pkg.name}  ${theme.muted(flags.join(" | "))}${summary}\n  ${theme.muted(`Install: openclaw plugins install clawhub:${pkg.name}`)}`;
}

/** Search ClawHub for installable plugins and write JSON or terminal output. */
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

  try {
    const results = await searchInstallablePluginPackages({ query, limit: opts.limit });

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
