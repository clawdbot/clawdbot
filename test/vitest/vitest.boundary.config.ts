import { defineProject } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveVitestIsolation } from "./vitest.scoped-config.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function loadBoundaryIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createBoundaryVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const cliIncludePatterns = narrowIncludePatternsForCli(boundaryTestFiles, argv);
  const isolate = resolveVitestIsolation(env);
  return defineProject({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      name: "boundary",
      isolate,
      ...(isolate ? { runner: undefined } : { runner: nonIsolatedRunnerPath }),
      include: loadBoundaryIncludePatternsFromEnv(env) ?? cliIncludePatterns ?? boundaryTestFiles,
      ...(cliIncludePatterns?.length === 0 ? { passWithNoTests: true } : {}),
      // Boundary workers still need the shared isolated HOME/bootstrap. Only
      // per-file module isolation is disabled here.
      setupFiles: sharedVitestConfig.test.setupFiles,
    },
  });
}

export default createBoundaryVitestConfig();
