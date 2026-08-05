import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
// CLI process tests run serially in isolated forks so child startup deadlines
// measure the CLI rather than contention from the shared CLI test graph.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliProcessVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(cliProcessTestFiles, {
    env,
    fileParallelism: false,
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
