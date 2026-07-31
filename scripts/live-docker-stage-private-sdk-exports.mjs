#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_SUBPATH_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export function addStagedPrivatePluginSdkExports(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  const privateSubpathsPath = path.join(
    repoRoot,
    "scripts",
    "lib",
    "plugin-sdk-private-local-only-subpaths.json",
  );
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const privateSubpaths = JSON.parse(fs.readFileSync(privateSubpathsPath, "utf8"));

  if (!packageJson.exports || typeof packageJson.exports !== "object") {
    throw new Error("staged package.json must define object exports");
  }
  if (!Array.isArray(privateSubpaths)) {
    throw new Error("private plugin SDK subpaths must be an array");
  }

  for (const subpath of privateSubpaths) {
    if (typeof subpath !== "string" || !PRIVATE_SUBPATH_PATTERN.test(subpath)) {
      throw new Error(`invalid private plugin SDK subpath: ${String(subpath)}`);
    }
    const sourcePath = `./src/plugin-sdk/${subpath}.ts`;
    if (!fs.existsSync(path.join(repoRoot, sourcePath))) {
      throw new Error(`missing private plugin SDK source: ${sourcePath}`);
    }
    packageJson.exports[`./plugin-sdk/${subpath}`] ??= {
      types: sourcePath,
      default: sourcePath,
    };
  }

  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  addStagedPrivatePluginSdkExports(path.resolve(process.argv[2] ?? "."));
}
