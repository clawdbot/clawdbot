import type { ViteUserConfig } from "vitest/config";
import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
// CLI process/lifecycle tests run serially in isolated forks so process-global
// state and child startup deadlines stay independent of the shared CLI graph.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliProcessVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(cliProcessTestFiles, {
    env,
    fileParallelism: false,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: "cli-process",
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: false,
  });
  return {
    ...config,
    test: {
      ...config.test,
      env: {
        ...config.test?.env,
        // Avoid TSX's unbounded wait on esbuild's synchronous worker IPC in source-child tests.
        ESBUILD_WORKER_THREADS: "0",
      },
    },
  };
}

export default createCliProcessVitestConfig();
