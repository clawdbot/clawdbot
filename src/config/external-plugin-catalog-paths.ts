/** Resolves where external plugin catalog files live for one environment. */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];

function splitEnvPaths(value: string): string[] {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return [];
  }
  return normalizeStringEntries(
    trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)),
  );
}

/**
 * The external catalog files a channel `preferOver` declaration can arrive in, resolved to
 * absolute paths for one environment. Two readers share this so they cannot disagree about which
 * files are in scope: the auto-enable reader that parses them, and the plugin loader's cache
 * identity — a cached registry bakes in the cede map those declarations produced, so two loads
 * that differ only by `OPENCLAW_PLUGIN_CATALOG_PATHS` must not share a cache entry.
 *
 * Paths only. Rewriting a catalog at the same path is a known limitation: it leaves the registry
 * cache key unchanged. The registry load cache that would need clearing is currently cleared by
 * `clearPluginRegistryLoadCache()` on plugin config mutation, not on catalog rewrite or the plugin
 * metadata lifecycle clear.
 */
export function resolveExternalPluginCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  for (const key of ENV_CATALOG_PATHS) {
    const raw = normalizeOptionalString(env[key]);
    if (raw) {
      return splitEnvPaths(raw).map((rawPath) => resolveUserPath(rawPath, env));
    }
  }
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}
