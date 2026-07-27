#!/usr/bin/env node

// Verifies publishable plugin packages can build their npm runtime outputs.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPluginNpmRuntime,
  listPluginNpmRuntimeBuildOutputs,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "./lib/plugin-npm-runtime-build.mjs";

function readPackageArgValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error("missing value for --package");
  }
  return value;
}

function usage() {
  return "usage: node scripts/check-plugin-npm-runtime-builds.mjs [--package extensions/<id> ...]";
}

export function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, packageDirs: [] };
  }
  const packageDirs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--package") {
      packageDirs.push(readPackageArgValue(args, index));
      index += 1;
      continue;
    }
    throw new Error(usage());
  }
  return { packageDirs };
}

/**
 * Builds publishable plugin npm runtimes and verifies declared outputs exist.
 */
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
      status: "built",
      entryCount: Object.keys(result.entry).length,
      copiedStaticAssets: result.copiedStaticAssets,
    });
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const rows = await checkPluginNpmRuntimeBuilds(args);
    const builtCount = rows.filter((row) => row.status === "built").length;
    console.log(`checked ${rows.length} publishable plugins; built ${builtCount} npm runtimes`);
    for (const row of rows) {
      console.log(
        [
          row.pluginDir,
          row.status,
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
