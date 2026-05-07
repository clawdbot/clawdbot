import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";

export const runNodeSourceRoots = ["src", BUNDLED_PLUGIN_ROOT_DIR];
export const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
export const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const ignoredRunNodeRepoPathPatterns = [
  /^extensions\/[^/]+\/src\/host\/.+\/\.bundle\.hash$/u,
  /^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u,
];
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;

export const normalizeRunNodePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

const isRelevantRunNodePath = (repoPath, isRelevantBundledPluginPath) => {
  const normalizedPath = normalizeRunNodePath(repoPath).replace(/^\.\/+/, "");
  if (ignoredRunNodeRepoPathPatterns.some((pattern) => pattern.test(normalizedPath))) {
    return false;
  }
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);
