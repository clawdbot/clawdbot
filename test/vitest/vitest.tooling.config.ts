// Vitest tooling config wires the tooling test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingDockerTestFiles } from "./vitest.tooling-docker.config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["test/**/*.test.ts", "src/scripts/**/*.test.ts"], {
    env,
    exclude: [...boundaryTestFiles, ...toolingDockerTestFiles, ...toolingIsolatedTestFiles],
    fileParallelism: false,
    includeOpenClawRuntimeSetup: false,
    name: "tooling",
    passWithNoTests: true,
  });
}

export default createToolingVitestConfig();
