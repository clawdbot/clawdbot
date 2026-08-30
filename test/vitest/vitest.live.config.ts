// Vitest live config wires the live test shard.
import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_LIVE_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import baseConfig from "./vitest.config.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; setupFiles?: string[] } }).test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.live.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    // Live suites need immediate provider/gateway progress output rather than
    // Vitest's buffered per-test console capture.
    disableConsoleIntercept: true,
    maxWorkers: 1,
    setupFiles: [
      ...new Set(
        [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(resolveRepoRootPath),
      ),
    ],
    include: [
      "src/**/*.live.test.ts",
      "test/**/*.live.test.ts",
      "packages/*/src/**/*.live.test.ts",
      BUNDLED_PLUGIN_LIVE_TEST_GLOB,
    ],
    exclude,
  },
});
