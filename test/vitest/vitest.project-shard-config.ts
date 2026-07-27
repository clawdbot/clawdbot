// Vitest project shard helper builds configs for full-suite shards.
import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export function createProjectShardVitestConfig(projects: readonly string[]) {
  const maxWorkers = sharedVitestConfig.test.maxWorkers;
  if (!process.env.OPENCLAW_VITEST_MAX_WORKERS && typeof maxWorkers === "number") {
    process.env.OPENCLAW_VITEST_MAX_WORKERS = String(maxWorkers);
  }
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      runner: nonIsolatedRunnerPath,
      projects: [...projects],
    },
  });
}
