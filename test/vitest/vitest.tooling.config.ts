// Vitest tooling config wires the tooling test shard.
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingDockerTestFiles } from "./vitest.tooling-docker.config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    loadIncludePatternsFromEnv(env) ?? ["test/**/*.test.ts", "src/scripts/**/*.test.ts"],
    {
      env,
      exclude: [...boundaryTestFiles, ...toolingDockerTestFiles, ...toolingIsolatedTestFiles],
      fileParallelism: false,
      includeOpenClawRuntimeSetup: false,
      name: "tooling",
      passWithNoTests: true,
    },
  );
}

export default createToolingVitestConfig();
