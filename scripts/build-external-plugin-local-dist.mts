#!/usr/bin/env node
// Builds source-checkout runtime output for externally published first-party plugins.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "./lib/bundled-plugin-build-entries.mjs";
import { shouldBuildBundledCluster } from "./lib/optional-bundled-clusters.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import {
  buildPluginNpmRuntime,
  listPublishablePluginPackageDirs,
  type PluginPackageJson,
} from "./lib/plugin-npm-runtime-build.mts";

type ExternalPluginLocalDistParams = {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  logLevel?: "silent" | "warn";
};

function readPluginPackageJson(repoRoot: string, packageDir: string): PluginPackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packageDir, "package.json"), "utf8"));
}

/** Lists external first-party packages that need source-checkout dist output. */
export function listExternalPluginLocalDistPackageDirs(
  params: Pick<ExternalPluginLocalDistParams, "repoRoot" | "env"> = {},
): string[] {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const env = params.env ?? process.env;
  if (env[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]?.trim()) {
    return [];
  }
  return listPublishablePluginPackageDirs({ repoRoot }).filter((packageDir) => {
    const packageJson = readPluginPackageJson(repoRoot, packageDir);
    return (
      packageJson.openclaw?.build?.bundledDist === false &&
      shouldBuildBundledCluster(path.basename(packageDir), env, { packageJson })
    );
  });
}

/** Builds isolated plugin graphs, then stages every output below its excluded root dist path. */
export async function buildExternalPluginLocalDist(
  params: ExternalPluginLocalDistParams = {},
): Promise<{ durationMs: number; pluginDirs: string[] }> {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDirs = listExternalPluginLocalDistPackageDirs({
    repoRoot,
    env: params.env,
  });
  const startedAt = performance.now();
  const pluginDirs: string[] = [];

  for (const packageDir of packageDirs) {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir,
      // Standalone package validation owns its existing bundler warnings; this
      // root build still surfaces errors and validates every emitted host import.
      logLevel: params.logLevel ?? "error",
    });
    if (!result) {
      throw new Error(`${packageDir} did not produce source-checkout runtime output`);
    }
    const targetDir = path.join(repoRoot, "dist", "extensions", result.pluginDir);
    assertRealOutputRoot(targetDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(result.outDir, targetDir, { recursive: true });
    fs.rmSync(result.outDir, { recursive: true, force: true });
    pluginDirs.push(result.pluginDir);
  }

  return {
    durationMs: performance.now() - startedAt,
    pluginDirs,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await buildExternalPluginLocalDist();
    console.log(
      `[external-plugin-local-dist] built ${result.pluginDirs.length} plugins in ${Math.round(result.durationMs)}ms`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
