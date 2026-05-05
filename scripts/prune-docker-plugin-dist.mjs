import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRootPackageExcludedExtensionDirs } from "./lib/bundled-plugin-build-entries.mjs";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function parsePluginList(value) {
  if (typeof value !== "string") {
    return new Set();
  }
  return new Set(
    value
      .split(/[\s,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function parseDockerPluginKeepList(value) {
  return parsePluginList(value);
}

export function pruneDockerPluginDist(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const keepPluginIds = parseDockerPluginKeepList(env.OPENCLAW_EXTENSIONS);
  const excludedPluginIds = collectRootPackageExcludedExtensionDirs({ cwd: repoRoot });
  const removed = [];

  for (const pluginId of [...excludedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (keepPluginIds.has(pluginId)) {
      continue;
    }

    for (const root of ["dist", "dist-runtime"]) {
      const pluginDistDir = path.join(repoRoot, root, "extensions", pluginId);
      if (!fs.existsSync(pluginDistDir)) {
        continue;
      }
      removePathIfExists(pluginDistDir);
      removed.push(path.relative(repoRoot, pluginDistDir).replaceAll("\\", "/"));
    }
  }

  return removed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  pruneDockerPluginDist();
}
