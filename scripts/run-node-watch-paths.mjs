// Defines source/config paths that pnpm dev watches for rebuilds and restarts.
import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";

const RUN_NODE_PACKAGE_SOURCE_ROOTS = [
  // Root runtime code imports these package sources through tsconfig aliases,
  // while pnpm dev/watch still runs the root dist entrypoint. Treat them like
  // src/ so edits restart the same process that consumes them.
  "packages/gateway-client/src",
  "packages/gateway-protocol/src",
  "packages/markdown-core/src",
  "packages/media-core/src",
  "packages/media-generation-core/src",
  "packages/media-understanding-common/src",
  "packages/normalization-core/src",
  "packages/acp-core/src",
  "packages/terminal-core/src",
  "packages/web-content-core/src",
  "packages/net-policy/src",
];

/** Source roots whose changes require the root dev build pipeline. */
export const runNodeSourceRoots = [
  "src",
  ...RUN_NODE_PACKAGE_SOURCE_ROOTS,
  BUNDLED_PLUGIN_ROOT_DIR,
];
/** Root config files whose changes invalidate the dev build. */
export const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
/** Combined watch list used by the run-node wrapper. */
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
/** Plugin metadata files that require a runtime restart even without source edits. */
export const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const ignoredRunNodeRepoPathPatterns = [
  /^extensions\/[^/]+\/src\/host\/.+\/\.bundle\.hash$/u,
  /^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u,
];
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;

/** Normalizes watch paths to repository-style POSIX separators. */
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
  for (const sourceRoot of RUN_NODE_PACKAGE_SOURCE_ROOTS) {
    if (normalizedPath.startsWith(`${sourceRoot}/`)) {
      return !isIgnoredSourcePath(normalizedPath.slice(sourceRoot.length + 1));
    }
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

/** Returns true when a repo path should trigger a dev rebuild. */
export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

/** Returns true when a repo path should restart the running dev process. */
export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);
