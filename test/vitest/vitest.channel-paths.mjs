// Test routing roots and globs for core channel tests and channel plugin tests.
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "../../scripts/lib/bundled-plugin-paths.mjs";
import { splitChannelExtensionTestRoots } from "./vitest.extension-channel-split-paths.mjs";

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const channelTestRoots = ["src/channels", ...splitChannelExtensionTestRoots];

const splitChannelExtensionTestRootSet = new Set(splitChannelExtensionTestRoots);

const extensionChannelTestRoots = channelTestRoots.filter(
  (root) =>
    root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) && !splitChannelExtensionTestRootSet.has(root),
);
const coreChannelTestRoots = channelTestRoots.filter(
  (root) => !root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX),
);
const channelTestPrefixes = channelTestRoots.map((root) => `${root}/`);
export const extensionChannelTestInclude = extensionChannelTestRoots.map(
  (root) => `${root}/**/*.test.ts`,
);
export const coreChannelTestInclude = coreChannelTestRoots.map((root) => `${root}/**/*.test.ts`);

export const extensionExcludedChannelTestGlobs = channelTestRoots
  .filter((root) => root.startsWith(BUNDLED_PLUGIN_PATH_PREFIX))
  .map((root) => root.slice(BUNDLED_PLUGIN_PATH_PREFIX.length))
  .map((relativeRoot) => `${relativeRoot}/**`);

export function isChannelSurfaceTestFile(filePath) {
  const normalizedFile = normalizeRepoPath(filePath);
  return channelTestPrefixes.some((prefix) => normalizedFile.startsWith(prefix));
}
