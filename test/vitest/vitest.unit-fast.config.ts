import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createUnitFastVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const unitFastTestFiles = getUnitFastTestFiles();
  const cliInclude = narrowIncludePatternsForCli(unitFastTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "unit-fast",
      isolate: false,
      runner: undefined,
      setupFiles: [],
      include: includeFromEnv ?? cliInclude ?? unitFastTestFiles,
      exclude: sharedTest.exclude ?? [],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastVitestConfig();
