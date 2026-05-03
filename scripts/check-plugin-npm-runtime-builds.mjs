#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPluginNpmRuntime,
  listPluginNpmRuntimeBuildOutputs,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "./lib/plugin-npm-runtime-build.mjs";

function parseArgs(argv) {
  const packageDirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package") {
      const packageDir = argv[index + 1];
      if (!packageDir) {
        throw new Error("missing value for --package");
      }
      packageDirs.push(packageDir);
      index += 1;
      continue;
    }
    throw new Error(
      "usage: node scripts/check-plugin-npm-runtime-builds.mjs [--package extensions/<id> ...]",
    );
  }
  return { packageDirs };
}

export async function checkPluginNpmRuntimeBuilds(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDirs =
    params.packageDirs?.length > 0
      ? params.packageDirs
      : listPublishablePluginPackageDirs({ repoRoot });
  const rows = [];
  for (const packageDir of packageDirs) {
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir });
    if (!plan) {
      throw new Error(`${packageDir} did not produce a package-local runtime build plan`);
    }
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir,
      logLevel: params.logLevel ?? "warn",
    });
    const missing = listPluginNpmRuntimeBuildOutputs(result).filter(
      (runtimePath) =>
        !fs.existsSync(path.join(result.packageDir, runtimePath.replace(/^\.\//u, ""))),
    );
    if (missing.length > 0) {
      throw new Error(`${packageDir} missing built runtime outputs: ${missing.join(", ")}`);
    }
    rows.push({
      pluginDir: result.pluginDir,
      entryCount: Object.keys(result.entry).length,
      copiedStaticAssets: result.copiedStaticAssets,
    });
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const rows = await checkPluginNpmRuntimeBuilds(args);
    console.log(`built ${rows.length} publishable plugin runtimes`);
    for (const row of rows) {
      console.log(
        [
          row.pluginDir,
          row.entryCount,
          row.copiedStaticAssets.length > 0 ? row.copiedStaticAssets.join(",") : "-",
        ].join("\t"),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
