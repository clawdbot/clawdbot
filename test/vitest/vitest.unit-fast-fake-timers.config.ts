// Vitest unit fast fake timers config wires the unit fast fake timers test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { getUnitFastTimerTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createUnitFastFakeTimersVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const unitFastTimerTestFiles = getUnitFastTimerTestFiles();
  const cliInclude = narrowIncludePatternsForCli(unitFastTimerTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "unit-fast-fake-timers",
      isolate: false,
      runner: nonIsolatedRunnerPath,
      setupFiles: [],
      include: includeFromEnv ?? cliInclude ?? unitFastTimerTestFiles,
      exclude: sharedTest.exclude ?? [],
      maxWorkers: 1,
      fileParallelism: false,
      sequence: {
        ...sharedTest.sequence,
        groupOrder: 1,
      },
      passWithNoTests: true,
    },
  });
}

export default createUnitFastFakeTimersVitestConfig();
