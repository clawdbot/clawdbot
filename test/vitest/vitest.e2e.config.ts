// Vitest e2e config wires the e2e test shard.
import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import baseConfig from "./vitest.config.ts";
import { RepoE2eSequencer } from "./vitest.e2e.sequencer.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { tuiPtyTestFiles } from "./vitest.test-shards.mjs";
import { uiE2eRealGatewayTestFiles } from "./vitest.ui-e2e.config.ts";

function resolveE2EWorkerCount(env: Record<string, string | undefined>): number {
  const requestedWorkers = Number.parseInt(env.OPENCLAW_E2E_WORKERS ?? "", 10);
  return Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(16, requestedWorkers)
    : 1;
}

const base = baseConfig as unknown as Record<string, unknown>;
const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; projects?: string[]; setupFiles?: string[] } })
    .test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};
const exclude = [
  ...(baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts"),
  ...tuiPtyTestFiles,
  // Browser suites, including plugin-local files, need the Control UI project's setup.
  ...uiE2eRealGatewayTestFiles,
];

export function createE2EVitestConfig(env: Record<string, string | undefined> = process.env) {
  // Keep e2e runs deterministic by default; callers can still opt into parallelism.
  const e2eWorkers = resolveE2EWorkerCount(env);
  const verboseE2E = env.OPENCLAW_E2E_VERBOSE === "1";

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      maxWorkers: e2eWorkers,
      reporters: [...sharedVitestConfig.test.reporters, "default"],
      sequence: { sequencer: RepoE2eSequencer },
      silent: !verboseE2E,
      globalSetup: [resolveRepoRootPath("test/vitest/vitest.e2e.global-setup.ts")],
      setupFiles: [
        ...new Set(
          [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(
            resolveRepoRootPath,
          ),
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
}

export default createE2EVitestConfig();
