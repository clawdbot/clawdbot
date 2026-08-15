#!/usr/bin/env node

// Regenerates package.json plugin-sdk export entries from the canonical entry list
// and keeps the workspace facade package (@openclaw/plugin-sdk) exports aligned
// with its src facade files.
import fs from "node:fs";
import path from "node:path";
import { buildPluginSdkPackageExports, pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mts";

const checkOnly = process.argv.includes("--check");
const repoRoot = process.cwd();
let failed = false;

function syncRootPackageExports() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson: Record<string, unknown> & { exports?: Record<string, unknown> } = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8"),
  );
  const currentExports = packageJson.exports ?? {};
  const syncedPluginSdkExports = buildPluginSdkPackageExports();

  const nextExports: typeof currentExports = {};
  let insertedPluginSdkExports = false;
  for (const [key, value] of Object.entries(currentExports)) {
    if (key.startsWith("./plugin-sdk")) {
      if (!insertedPluginSdkExports) {
        Object.assign(nextExports, syncedPluginSdkExports);
        insertedPluginSdkExports = true;
      }
      continue;
    }
    nextExports[key] = value;
    if (key === "." && !insertedPluginSdkExports) {
      Object.assign(nextExports, syncedPluginSdkExports);
      insertedPluginSdkExports = true;
    }
  }

  if (!insertedPluginSdkExports) {
    Object.assign(nextExports, syncedPluginSdkExports);
  }

  if (JSON.stringify(currentExports) === JSON.stringify(nextExports)) {
    return;
  }
  if (checkOnly) {
    console.error("plugin-sdk exports out of sync. Run `pnpm plugin-sdk:sync-exports`.");
    failed = true;
    return;
  }
  packageJson.exports = nextExports;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

// The workspace facade package mirrors a subset of plugin SDK entrypoints for
// package-name resolution inside the monorepo. Every export key must have a src
// facade file (its runtime `default` target) and name a canonical SDK entrypoint;
// dangling keys typecheck via prebuilt dist d.ts but fail on runtime resolution.
// Validation runs before any manifest write so an invalid facade cannot leave a
// partially rewritten export map behind a zero exit status.
function collectFacadeSubpaths(): string[] | null {
  const facadeSubpaths = fs
    .readdirSync(path.join(repoRoot, "packages", "plugin-sdk", "src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -".ts".length))
    .toSorted();
  const entrypointSet = new Set(pluginSdkEntrypoints);
  const staleFacades = facadeSubpaths.filter((subpath) => !entrypointSet.has(subpath));
  if (staleFacades.length === 0) {
    return facadeSubpaths;
  }
  for (const subpath of staleFacades) {
    console.error(
      `packages/plugin-sdk/src/${subpath}.ts does not match any plugin SDK entrypoint. ` +
        "Delete the facade or add the entrypoint to scripts/lib/plugin-sdk-entrypoints.json.",
    );
  }
  return null;
}

function syncFacadePackageExports(facadeSubpaths: string[]) {
  const facadePackageJsonPath = path.join(repoRoot, "packages", "plugin-sdk", "package.json");
  const facadePackageJson: Record<string, unknown> & { exports?: Record<string, unknown> } =
    JSON.parse(fs.readFileSync(facadePackageJsonPath, "utf8"));
  const nextExports = Object.fromEntries(
    facadeSubpaths.map((subpath) => [
      `./${subpath}`,
      {
        types: `./dist/src/plugin-sdk/${subpath}.d.ts`,
        default: `./src/${subpath}.ts`,
      },
    ]),
  );
  if (JSON.stringify(facadePackageJson.exports ?? {}) === JSON.stringify(nextExports)) {
    return;
  }
  if (checkOnly) {
    const currentKeys = new Set(Object.keys(facadePackageJson.exports ?? {}));
    const expectedKeys = new Set(Object.keys(nextExports));
    for (const key of currentKeys) {
      if (!expectedKeys.has(key)) {
        console.error(`packages/plugin-sdk exports ${key} has no src facade file.`);
      }
    }
    for (const key of expectedKeys) {
      if (!currentKeys.has(key)) {
        console.error(`packages/plugin-sdk src facade ${key} is missing from exports.`);
      }
    }
    console.error("packages/plugin-sdk exports out of sync. Run `pnpm plugin-sdk:sync-exports`.");
    failed = true;
    return;
  }
  facadePackageJson.exports = nextExports;
  fs.writeFileSync(
    facadePackageJsonPath,
    `${JSON.stringify(facadePackageJson, null, 2)}\n`,
    "utf8",
  );
}

const facadeSubpaths = collectFacadeSubpaths();
if (facadeSubpaths === null) {
  process.exit(1);
}
syncRootPackageExports();
syncFacadePackageExports(facadeSubpaths);
if (failed) {
  process.exit(1);
}
if (checkOnly) {
  console.log("plugin-sdk exports synced.");
}
