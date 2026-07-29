#!/usr/bin/env node

// Regenerates package.json plugin-sdk export entries from the canonical entry list.
import fs from "node:fs";
import path from "node:path";
import { buildPluginSdkPackageExports } from "./lib/plugin-sdk-entries.mjs";

const checkOnly = process.argv.includes("--check");
const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentExports = packageJson.exports ?? {};
const syncedPluginSdkExports = buildPluginSdkPackageExports();

const nextExports = {};
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

const nextExportsJson = JSON.stringify(nextExports);
const currentExportsJson = JSON.stringify(currentExports);
if (checkOnly) {
  if (currentExportsJson !== nextExportsJson) {
    console.error("plugin-sdk exports out of sync. Run `pnpm plugin-sdk:sync-exports`.");
    process.exit(1);
  }
  console.log("plugin-sdk exports synced.");
  process.exit(0);
}

packageJson.exports = nextExports;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
