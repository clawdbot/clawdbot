import os from "node:os";
import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import baseConfig from "./vitest.config.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
// Keep e2e runs cheap by default; callers can still override via OPENCLAW_E2E_WORKERS.
const defaultWorkers = isCI ? Math.min(2, Math.max(1, Math.floor(cpuCount * 0.25))) : 1;
const requestedWorkers = Number.parseInt(process.env.OPENCLAW_E2E_WORKERS ?? "", 10);
const e2eWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(16, requestedWorkers)
    : defaultWorkers;
const verboseE2E = process.env.OPENCLAW_E2E_VERBOSE === "1";

const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; projects?: string[]; setupFiles?: string[] } })
    .test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    maxWorkers: e2eWorkers,
    silent: !verboseE2E,
    setupFiles: [
      ...new Set(
        [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(resolveRepoRootPath),
      ),
    ],
    include: [
      "test/**/*.e2e.test.ts",
      "src/**/*.e2e.test.ts",
      "packages/**/*.e2e.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
      BUNDLED_PLUGIN_E2E_TEST_GLOB,
    ],
    exclude,
  },
});
