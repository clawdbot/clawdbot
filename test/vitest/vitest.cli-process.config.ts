import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
// CLI process tests run serially in isolated forks so child startup deadlines
// measure the CLI rather than contention from the shared CLI test graph.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliProcessVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(cliProcessTestFiles, {
    env,
    fileParallelism: false,
    isolate: true,
    name: "cli-process",
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: false,
  });
}

export default createCliProcessVitestConfig();
