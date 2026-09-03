// Shared Codex plugin install helpers for E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./fixtures/common.mjs";
import {
  resolveOpenClawConfigPath as configPath,
  resolveOpenClawStateDir as stateDir,
} from "./openclaw-state-paths.mjs";
import { readPluginInstallRecords } from "./plugin-index-sqlite.mjs";

export { configPath, readJson, stateDir };

export function managedNpmRoot() {
  return path.join(stateDir(), "npm");
}

export function realPathMaybe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function assertPathInside(parentPath, childPath, label) {
  const parent = realPathMaybe(parentPath);
  const child = realPathMaybe(childPath);
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolved outside ${parentPath}: ${child}`);
  }
}

export function readInstallRecords(fallbackRecords = {}) {
  return readPluginInstallRecords({ fallbackRecords });
}

export function npmProjectRootForInstalledPackage(installPath, packageName) {
  const packageRoot = packageName
    .split("/")
    .reduce((current) => path.dirname(current), installPath);
  return path.basename(packageRoot) === "node_modules"
    ? path.dirname(packageRoot)
    : managedNpmRoot();
}

export function findPackageJson(packageName, roots) {
  const packagePath = packageName.startsWith("@")
    ? path.join(...packageName.split("/"), "package.json")
    : path.join(packageName, "package.json");
  const candidates = roots.map((root) => path.join(root, "node_modules", packagePath));
  return candidates.find((candidate) => fs.existsSync(candidate));
}
