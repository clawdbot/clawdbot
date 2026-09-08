#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_UPDATE_COMPAT_CHUNKS = [
  "shared-DTaQo6Hi.js",
  "shared-Y6bNiw2w.js",
  "shared-DFJEouXv.js",
];
export const FUTURE_FIXTURE_VERSION = "2026.9.99-first-hop.0";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFixturePaths(packageRoot) {
  const root = path.resolve(packageRoot);
  const packageJson = path.join(root, "package.json");
  const buildInfo = path.join(root, "dist", "build-info.json");
  const inventory = path.join(root, "dist", "postinstall-inventory.json");
  for (const filePath of [packageJson, buildInfo, inventory]) {
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`missing package fixture input: ${filePath}`);
    }
  }
  return { root, packageJson, buildInfo, inventory };
}

export function removeLegacyUpdateCompatChunks(packageRoot) {
  const paths = resolveFixturePaths(packageRoot);
  const inventory = readJson(paths.inventory);
  if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
    throw new Error("package fixture inventory is not a string array");
  }

  const removed = [];
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    const relativePath = `dist/${name}`;
    const filePath = path.join(paths.root, relativePath);
    if (!fs.existsSync(filePath) || !inventory.includes(relativePath)) {
      throw new Error(`package fixture is missing compatibility input: ${relativePath}`);
    }
    fs.rmSync(filePath);
    removed.push(relativePath);
  }
  writeJson(
    paths.inventory,
    inventory.filter((entry) => !removed.includes(entry)),
  );
}

export function markFutureUpdateFixture(packageRoot) {
  removeLegacyUpdateCompatChunks(packageRoot);
  const paths = resolveFixturePaths(packageRoot);
  const packageJson = readJson(paths.packageJson);
  const buildInfo = readJson(paths.buildInfo);
  packageJson.version = FUTURE_FIXTURE_VERSION;
  buildInfo.version = FUTURE_FIXTURE_VERSION;
  buildInfo.buildId = `${FUTURE_FIXTURE_VERSION}-${buildInfo.commit}-future-fixture`;
  writeJson(paths.packageJson, packageJson);
  writeJson(paths.buildInfo, buildInfo);
}

function main() {
  const [mode, packageRoot] = process.argv.slice(2);
  if (!packageRoot || (mode !== "negative" && mode !== "future")) {
    throw new Error(
      "usage: update-first-hop-package-fixtures.mjs <negative|future> <package-root>",
    );
  }
  if (mode === "negative") {
    removeLegacyUpdateCompatChunks(packageRoot);
  } else {
    markFutureUpdateFixture(packageRoot);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
