// Builds and validates static assets needed by package-local plugin runtime output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { discoverStaticExtensionAssets } from "./static-extension-assets.mjs";

function resolvePackageAssetBuildCommand(packageJson) {
  const command = packageJson.openclaw?.assetScripts?.build;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/** Run a package-local static asset build command when the plugin declares one. */
export function runPackageAssetBuild(plan) {
  const command = resolvePackageAssetBuildCommand(plan.packageJson);
  if (!command) {
    return null;
  }
  console.error(`[plugin-npm-runtime-build] build assets ${plan.pluginDir}: ${command}`);
  const result = spawnSync(command, {
    cwd: plan.packageDir,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${plan.pluginDir} asset build failed: ${command}`);
  }
  return command;
}

/** List static asset source paths referenced by a package but missing from disk. */
export function listMissingPackageStaticAssetSources(plan) {
  const packagePrefix = `extensions/${plan.pluginDir}/`;
  return discoverStaticExtensionAssets({ rootDir: plan.repoRoot })
    .filter((asset) => asset.src.replaceAll("\\", "/").startsWith(packagePrefix))
    .map((asset) => asset.src)
    .filter((src) => !fs.existsSync(path.join(plan.repoRoot, src)))
    .toSorted((left, right) => left.localeCompare(right));
}
