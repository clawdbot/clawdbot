// Vitest bundled plugin paths helper lists test file patterns for the bundled plugin paths shard.
export const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
export const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
export const BUNDLED_PLUGIN_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`;
export const BUNDLED_PLUGIN_E2E_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.e2e.test.ts`;
export const BUNDLED_PLUGIN_LIVE_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.live.test.ts`;
