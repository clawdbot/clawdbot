// Vitest unit fast fake timers config wires the unit fast fake timers test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import {
  nonIsolatedRunnerPath,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { getUnitFastTimerTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createUnitFastFakeTimersVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const sharedSequence = (sharedTest as { sequence?: { groupOrder?: number } }).sequence;
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
      // Env isolation only (no shared-setup mocks), mirroring unit-fast.
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      include: includeFromEnv ?? cliInclude ?? unitFastTimerTestFiles,
      exclude: sharedTest.exclude ?? [],
      maxWorkers: 1,
      fileParallelism: false,
      sequence: {
        ...sharedSequence,
        groupOrder: 1,
      },
      passWithNoTests: true,
    },
  });
}

export default createUnitFastFakeTimersVitestConfig();
