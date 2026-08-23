import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
// Vitest cli config wires the cli test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/cli/**/*.test.ts"], {
    dir: "src/cli",
    env,
    exclude: cliProcessTestFiles,
    name: "cli",
    passWithNoTests: true,
  });
}

export default createCliVitestConfig();
